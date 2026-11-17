import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { TopicBatchSchema, type TopicBatch, type WorkEnvelope } from '@knowstudio/contracts';
import { cosineSimilarity, generateTopics, type EmbeddingPort, type LlmPort } from '@knowstudio/ai';
import type {
  MaterialRepository,
  TopicBatchResult,
  TopicRepository,
  WorkMaterialRepository,
  WorkRepository,
  WorkRow,
} from '@knowstudio/db/repositories';
import { assembleWorkEnvelope } from '../works/work-envelope.js';
import type { WorkQuotaReader, WorkTruthSnapshotLoader } from '../works/work-ports.js';
import { WORK_QUOTA_READER, WORK_REPOSITORY, WORK_TRUTH_SNAPSHOT } from '../works/works.tokens.js';
import { toMaterial } from './material-view.js';
import {
  EMBEDDING_PORT,
  LLM_PORT,
  MATERIAL_REPOSITORY,
  TOPIC_REPOSITORY,
  WORK_MATERIAL_REPOSITORY,
} from './discover.tokens.js';

export class TopicMaterialNotCollectedError extends Error {
  readonly code = 'TOPIC_MATERIAL_NOT_COLLECTED';
  constructor(readonly materialId: string) {
    super(`素材 ${materialId} 未收藏到当前作品`);
    this.name = 'TopicMaterialNotCollectedError';
  }
}

export class TopicRerollLimitError extends Error {
  readonly code = 'TOPIC_REROLL_LIMIT';
  constructor() {
    super('换一批次数已用完');
    this.name = 'TopicRerollLimitError';
  }
}

function hookFingerprint(hook: string): string {
  return createHash('sha256').update(hook.trim().normalize('NFKC')).digest('hex');
}

function toRfc3339(value: string): string {
  return `${value.replace(' ', 'T')}Z`;
}

@Injectable()
export class TopicsService {
  constructor(
    @Inject(TOPIC_REPOSITORY) private readonly topics: TopicRepository,
    @Inject(WORK_MATERIAL_REPOSITORY) private readonly workMaterials: WorkMaterialRepository,
    @Inject(MATERIAL_REPOSITORY) private readonly materials: MaterialRepository,
    @Inject(WORK_REPOSITORY) private readonly works: WorkRepository,
    @Inject(LLM_PORT) private readonly llm: LlmPort,
    @Inject(EMBEDDING_PORT) private readonly embedding: EmbeddingPort,
    @Inject(WORK_TRUTH_SNAPSHOT) private readonly snapshots: WorkTruthSnapshotLoader,
    @Inject(WORK_QUOTA_READER) private readonly quota: WorkQuotaReader,
  ) {}

  async generate(
    userId: string,
    work: WorkRow,
    input: { materialIds: readonly string[] },
  ): Promise<TopicBatchResult> {
    await this.materialIdsForGenerate(userId, work, input.materialIds);
    const existing = await this.topics.forUser(userId).latestBatch(work.id);
    if (existing !== null) return existing;
    return this.createBatch(userId, work, input.materialIds);
  }

  async reroll(userId: string, work: WorkRow): Promise<TopicBatchResult> {
    const latest = await this.topics.forUser(userId).latestBatch(work.id);
    if (latest === null) return this.createBatch(userId, work, []);
    if (latest.batch.regen_attempts >= 2) throw new TopicRerollLimitError();
    const basedOn = latest.batch.based_on_material_ids;
    return this.createBatch(userId, work, basedOn);
  }

  async batch(userId: string, work: WorkRow, batchIndex: number | undefined): Promise<TopicBatch> {
    const result =
      batchIndex === undefined
        ? await this.topics.forUser(userId).latestBatch(work.id)
        : await this.topics.forUser(userId).batchByIndex(work.id, batchIndex);
    if (result === null) throw new Error('TOPIC_BATCH_NOT_FOUND');
    return this.toContract(result);
  }

  async select(userId: string, work: WorkRow, topicId: string): Promise<WorkEnvelope> {
    const topic = await this.topics.forUser(userId).findTopic(topicId);
    if (topic === null || topic.work_id !== work.id) throw new Error('TOPIC_NOT_FOUND');
    const updated = await this.works.forUser(userId).selectTopic(work.id, topicId);
    if (updated === null) throw new Error('WORK_NOT_FOUND');
    const [snapshot, quota] = await Promise.all([
      this.snapshots.load(updated),
      this.quota.readForUser(userId),
    ]);
    return assembleWorkEnvelope(updated, snapshot, quota);
  }

  private async createBatch(
    userId: string,
    work: WorkRow,
    requestedMaterialIds: readonly string[],
  ): Promise<TopicBatchResult> {
    const materialIds = await this.materialIdsForGenerate(userId, work, requestedMaterialIds);
    const rows = await this.materials.forUser(userId).findByIds(materialIds);
    if (rows.length !== new Set(materialIds).size) throw new Error('TOPIC_MATERIAL_NOT_FOUND');
    const materials = materialIds.map((id) => {
      const row = rows.find((r) => r.id === id);
      if (row === undefined) throw new Error('TOPIC_MATERIAL_NOT_FOUND');
      return toMaterial(row, true);
    });

    const repo = this.topics.forUser(userId);
    const batchIndex = await repo.nextBatchIndex(work.id);
    const previous = new Set(await repo.listHookFingerprints(work.id));
    const generationIndex = Math.min(batchIndex - 1, 1);
    const generated = await generateTopics(
      { keyword: work.keyword ?? '', materials, generationIndex },
      this.llm,
    );
    const decorated = generated.topics
      .map((topic) => ({
        ...topic,
        hook: batchIndex > 2 ? `${topic.hook}（第 ${batchIndex} 批）` : topic.hook,
      }))
      .map((topic) => ({ ...topic, hookFingerprint: hookFingerprint(topic.hook) }))
      .filter((topic) => !previous.has(topic.hookFingerprint));
    if (decorated.length < 10) throw new Error('TOPIC_DIVERSITY_EXHAUSTED');

    const vectors = await this.embedding.embed(decorated.map((topic) => topic.hook));
    let maxCosine = 0;
    const candidates = decorated.map((topic, index) => {
      let score = 0;
      for (let prior = 0; prior < index; prior += 1) {
        const similarity = cosineSimilarity(vectors[index] ?? [], vectors[prior] ?? []);
        score = Math.max(score, similarity);
        maxCosine = Math.max(maxCosine, similarity);
      }
      return {
        hook: topic.hook,
        angle: topic.angle,
        blankPoint: topic.blankPoint,
        basisMaterialIds: topic.basisMaterialIds,
        embedding: vectors[index] ?? [],
        hookFingerprint: topic.hookFingerprint,
        diversityScore: score,
      };
    });
    if (maxCosine > 0.75) throw new Error('TOPIC_DIVERSITY_THRESHOLD_EXCEEDED');
    return repo.createBatch(work.id, materialIds, candidates, maxCosine);
  }

  private async materialIdsForGenerate(
    userId: string,
    work: WorkRow,
    requestedMaterialIds: readonly string[],
  ): Promise<readonly string[]> {
    const collected = await this.workMaterials.forUser(userId).listMaterialIdsForWork(work.id);
    const materialIds = requestedMaterialIds.length > 0 ? requestedMaterialIds : collected;
    if (materialIds.length === 0) throw new Error('TOPIC_MATERIALS_REQUIRED');
    const collectedSet = new Set(collected);
    for (const id of materialIds) {
      if (!collectedSet.has(id)) throw new TopicMaterialNotCollectedError(id);
    }
    return materialIds;
  }

  toContract(result: TopicBatchResult): TopicBatch {
    return TopicBatchSchema.parse({
      id: result.batch.id,
      workId: result.batch.work_id,
      batchIndex: result.batch.batch_index,
      topics: result.topics.map((topic) => ({
        id: topic.id,
        batchId: topic.batch_id,
        hook: topic.hook,
        gap: topic.blank_point,
        basisMaterialIds: topic.basis_material_ids,
        hookFingerprint: topic.hook_fingerprint,
      })),
      requestedCount: result.batch.effective_count,
      minPairwiseCosine:
        result.batch.min_pairwise_cosine === null ? null : Number(result.batch.min_pairwise_cosine),
    });
  }

  jobOf(result: TopicBatchResult) {
    const at = toRfc3339(result.batch.created_at);
    return {
      id: result.batch.id,
      workId: result.batch.work_id,
      type: 'topics',
      status: 'succeeded',
      stage: null,
      progress: 100,
      costPoints: 0,
      reservationId: null,
      attempt: 0,
      error: null,
      createdAt: at,
      updatedAt: at,
    };
  }
}
