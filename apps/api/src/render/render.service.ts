import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  RenderAccepted,
  JobSchema,
  type Job,
  type PatchVideoRequest,
  type PatchVideoResponse,
  type Script,
} from '@knowstudio/contracts';
import { enqueueInTransaction } from '@knowstudio/queue';
import {
  releaseQuotaInTransaction,
  reserveQuotaInTransaction,
  readQuota,
} from '@knowstudio/quota';
import { toJsonParam, type Database, type Kysely } from '@knowstudio/db';
import type { ScriptAggregate, ScriptRepository, WorkRow } from '@knowstudio/db/repositories';
import type { ObjectStorage } from '@knowstudio/storage';
import { deriveGates, nextStep, phaseOf } from '@knowstudio/domain';
import { DB_CLIENT, OBJECT_STORAGE } from '../shared/tokens.js';
import type { WorkTruthSnapshotLoader } from '../works/work-ports.js';
import { WORK_TRUTH_SNAPSHOT } from '../works/works.tokens.js';
import { SCRIPT_REPOSITORY } from '../discover/discover.tokens.js';

const DB_UTC_LITERAL = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/;

function toRfc3339(value: string): string {
  if (!DB_UTC_LITERAL.test(value)) throw new Error('RENDER_TIME_INVALID');
  return `${value.replace(' ', 'T')}Z`;
}

function newId(prefix: 'job' | 'va'): string {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`;
}

function fingerprintOf(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(input), 'utf8').digest('hex');
}

function stageLabel(stage: string | null): string | null {
  return stage;
}

function nowLiteral(): string {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

async function releaseReservationIfHeld(
  trx: Parameters<typeof releaseQuotaInTransaction>[0],
  reservationId: string,
  reason: string,
): Promise<void> {
  const reservation = await trx
    .selectFrom('quota_reservation')
    .select('state')
    .where('id', '=', reservationId)
    .executeTakeFirst();
  if (reservation?.state === 'held') {
    await releaseQuotaInTransaction(trx, reservationId, reason);
  }
}

export interface RenderJobView {
  readonly job: Job;
  readonly videoUrl: string | null;
}

type PatchLayerScope = readonly (
  | 'audio'
  | 'slides'
  | 'subtitles'
  | 'timeline'
  | 'bgm'
  | 'cover'
)[];

export class RenderGateNotSatisfiedError extends Error {
  readonly code = 'RENDER_GATE_NOT_SATISFIED';
  constructor() {
    super('文案尚未确认，无法生成视频');
    this.name = 'RenderGateNotSatisfiedError';
  }
}

export class RenderInProgressError extends Error {
  readonly code = 'RENDER_IN_PROGRESS';
  constructor(readonly activeJobId: string) {
    super('已有渲染任务进行中');
    this.name = 'RenderInProgressError';
  }
}

export class RenderNotFoundError extends Error {
  readonly code = 'RENDER_NOT_FOUND';
  constructor() {
    super('渲染任务不存在');
    this.name = 'RenderNotFoundError';
  }
}

@Injectable()
export class RenderService {
  constructor(
    @Inject(DB_CLIENT) private readonly db: Kysely<Database>,
    @Inject(SCRIPT_REPOSITORY) private readonly scripts: ScriptRepository,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(WORK_TRUTH_SNAPSHOT) private readonly snapshots: WorkTruthSnapshotLoader,
  ) {}

  async enqueue(userId: string, work: WorkRow, quality: 'draft' | 'hd'): Promise<RenderAccepted> {
    await this.assertGateG2(userId, work);
    if (work.active_render_job_id != null)
      throw new RenderInProgressError(work.active_render_job_id);
    const script = await this.scripts.forUser(userId).findLatest(work.id);
    if (script === null) throw new Error('SCRIPT_NOT_FOUND');
    const jobId = newId('job');
    const videoAssetId = newId('va');
    const costPoints = quality === 'hd' ? 2 : 0;
    const orient = 'vertical';
    const contract = this.toContract(script);
    const idempotencyKey = fingerprintOf({
      userId,
      workId: work.id,
      quality,
      scriptVersion: contract.version,
    });

    const result = await this.db.transaction().execute(async (trx) => {
      const reservationId = await reserveQuotaInTransaction(trx, {
        userId,
        workId: work.id,
        jobId,
        points: costPoints,
      });
      await trx
        .insertInto('video_asset')
        .values({
          id: videoAssetId,
          work_id: work.id,
          user_id: userId,
          quality,
          status: 'queued',
          storage_key: null,
          duration_ms: (contract.estimatedDuration ?? 0) * 1000,
          resolution: quality === 'hd' ? '1080x1920' : '480x854',
          orient,
          template_id: 'tpl_ink_minimal',
          voice_id: 'voice_steady_male',
          speed: '1.000',
          script_version: contract.version,
        })
        .execute();
      await trx
        .insertInto('render_job')
        .values({
          id: jobId,
          work_id: work.id,
          user_id: userId,
          type: quality,
          layer_scope: toJsonParam(['slides', 'subtitles', 'timeline', 'audio']),
          status: 'queued',
          progress: 0,
          stage: 'queued',
          cost_points: costPoints,
          reservation_id: reservationId,
          video_asset_id: videoAssetId,
          idempotency_key: idempotencyKey,
          attempt: 0,
          error: null,
          cancel_requested: 0,
        })
        .execute();
      const renderingStep = nextStep(work.step, 'hd:enqueued');
      await trx
        .updateTable('work')
        .set({
          active_render_job_id: jobId,
          step: renderingStep,
          phase: phaseOf(renderingStep),
          updated_at: new Date().toISOString().replace('T', ' ').replace('Z', ''),
        })
        .where('id', '=', work.id)
        .execute();
      await enqueueInTransaction(trx, {
        queue: `render.${quality}`,
        jobId,
        userId,
        payload: { workId: work.id, quality, scriptVersion: contract.version },
        dedupKey: idempotencyKey,
      });
      return { reservationId };
    });

    return RenderAccepted.parse({
      jobId,
      costPoints,
      reservationId: result.reservationId,
      quota: await readQuota(this.db, userId),
      sseUrl: `/api/jobs/${jobId}/events`,
    });
  }

  async previewPatch(
    userId: string,
    work: WorkRow,
    input: PatchVideoRequest,
  ): Promise<PatchVideoResponse> {
    await this.assertGateG2(userId, work);
    const invalidated = [
      ...(input.voiceId !== undefined || input.speed !== undefined
        ? ['audio', 'timeline', 'subtitles']
        : []),
      ...(input.templateId !== undefined ? ['slides'] : []),
      ...(input.subtitle === true ? ['subtitles'] : []),
    ] as PatchVideoResponse['invalidatedLayers'];
    const incrementalPoints =
      invalidated.includes('audio') || invalidated.includes('timeline')
        ? invalidated.includes('slides')
          ? 2
          : 1
        : invalidated.includes('slides')
          ? 1
          : 0;

    const latestAssetId = await this.db
      .selectFrom('video_asset')
      .select('id')
      .where('work_id', '=', work.id)
      .where('user_id', '=', userId)
      .orderBy('created_at', 'desc')
      .executeTakeFirst();
    if (latestAssetId !== undefined) {
      await this.db
        .updateTable('video_asset')
        .set({
          ...(input.templateId === undefined ? {} : { template_id: input.templateId }),
          ...(input.voiceId === undefined ? {} : { voice_id: input.voiceId }),
          ...(input.speed === undefined ? {} : { speed: input.speed.toFixed(3) }),
        })
        .where('id', '=', latestAssetId.id)
        .execute();
    }

    return {
      invalidatedLayers: [...new Set(invalidated)],
      incrementalPoints,
      requiresConfirm: incrementalPoints > 0,
    };
  }

  async enqueuePatch(
    userId: string,
    work: WorkRow,
    layerScope: PatchLayerScope,
  ): Promise<RenderAccepted> {
    await this.assertGateG2(userId, work);
    if (work.active_render_job_id != null) {
      throw new RenderInProgressError(work.active_render_job_id);
    }
    const script = await this.scripts.forUser(userId).findLatest(work.id);
    if (script === null) throw new Error('SCRIPT_NOT_FOUND');
    const latestAsset = await this.db
      .selectFrom('video_asset')
      .selectAll()
      .where('work_id', '=', work.id)
      .where('user_id', '=', userId)
      .orderBy('created_at', 'desc')
      .executeTakeFirst();
    if (latestAsset === undefined) throw new Error('VIDEO_ASSET_NOT_FOUND');

    const costPoints =
      layerScope.includes('audio') || layerScope.includes('timeline')
        ? layerScope.includes('slides')
          ? 2
          : 1
        : layerScope.includes('slides')
          ? 1
          : 0;
    const jobId = newId('job');
    const scope = [...new Set(layerScope)];
    const idempotencyKey = fingerprintOf({
      userId,
      workId: work.id,
      quality: 'patch',
      scriptVersion: script.row.version,
      scope,
      templateId: latestAsset.template_id,
      voiceId: latestAsset.voice_id,
      speed: latestAsset.speed,
    });

    await this.db.transaction().execute(async (trx) => {
      const reservationId = await reserveQuotaInTransaction(trx, {
        userId,
        workId: work.id,
        jobId,
        points: costPoints,
      });
      await trx
        .insertInto('render_job')
        .values({
          id: jobId,
          work_id: work.id,
          user_id: userId,
          type: 'patch',
          layer_scope: toJsonParam(scope),
          status: 'queued',
          progress: 0,
          stage: 'queued',
          cost_points: costPoints,
          reservation_id: reservationId,
          video_asset_id: latestAsset.id,
          idempotency_key: idempotencyKey,
          attempt: 0,
          error: null,
          cancel_requested: 0,
        })
        .execute();
      const renderingStep = nextStep(work.step, 'hd:enqueued');
      await trx
        .updateTable('work')
        .set({
          active_render_job_id: jobId,
          step: renderingStep,
          phase: phaseOf(renderingStep),
          updated_at: nowLiteral(),
        })
        .where('id', '=', work.id)
        .execute();
      await enqueueInTransaction(trx, {
        queue: 'render.patch',
        jobId,
        userId,
        payload: { workId: work.id, quality: 'patch', scriptVersion: script.row.version },
        dedupKey: idempotencyKey,
      });
    });

    return RenderAccepted.parse({
      jobId,
      costPoints,
      reservationId:
        costPoints === 0
          ? null
          : (
              await this.db
                .selectFrom('render_job')
                .select('reservation_id')
                .where('id', '=', jobId)
                .executeTakeFirstOrThrow()
            ).reservation_id,
      quota: await readQuota(this.db, userId),
      sseUrl: `/api/jobs/${jobId}/events`,
    });
  }

  /**
   * T-55 修复路径：移除或同类型替换作品素材引用；若原素材标注用于 slides，
   * 则同事务创建 0 点局部重算任务，保证引用与课件任务不会分裂。
   */
  async removeMaterialWithSlidesPatch(
    userId: string,
    work: WorkRow,
    materialId: string,
  ): Promise<RenderAccepted | null> {
    return this.changeMaterialReference(userId, work, materialId, null);
  }

  async replaceMaterialWithSlidesPatch(
    userId: string,
    work: WorkRow,
    materialId: string,
    replacementId: string,
  ): Promise<RenderAccepted | null> {
    return this.changeMaterialReference(userId, work, materialId, replacementId);
  }

  private async changeMaterialReference(
    userId: string,
    work: WorkRow,
    materialId: string,
    replacementId: string | null,
  ): Promise<RenderAccepted | null> {
    const latestAsset = await this.db
      .selectFrom('video_asset')
      .selectAll()
      .where('work_id', '=', work.id)
      .where('user_id', '=', userId)
      .orderBy('created_at', 'desc')
      .executeTakeFirst();
    const replacement =
      replacementId === null
        ? null
        : await this.db
            .selectFrom('material')
            .select(['id', 'type'])
            .where('id', '=', replacementId)
            .where((eb) => eb.or([eb('user_id', '=', userId), eb('user_id', 'is', null)]))
            .where('deleted_at', 'is', null)
            .executeTakeFirst();
    if (replacement === undefined) {
      throw new Error('MATERIAL_NOT_VISIBLE');
    }

    const result = await this.db.transaction().execute(async (trx) => {
      const reference = await trx
        .selectFrom('work_material')
        .select(['collected_at', 'used_in'])
        .where('work_id', '=', work.id)
        .where('material_id', '=', materialId)
        .where('user_id', '=', userId)
        .forUpdate()
        .executeTakeFirst();
      if (reference === undefined) return null;

      const usedIn = Array.isArray(reference.used_in) ? reference.used_in : [];
      if (replacementId === materialId) return null;
      if (replacement !== null) {
        const current = await trx
          .selectFrom('material')
          .select('type')
          .where('id', '=', materialId)
          .executeTakeFirstOrThrow();
        if (current.type !== replacement.type) throw new Error('MATERIAL_TYPE_MISMATCH');
        const alreadyReferenced = await trx
          .selectFrom('work_material')
          .select('material_id')
          .where('work_id', '=', work.id)
          .where('material_id', '=', replacementId)
          .where('user_id', '=', userId)
          .executeTakeFirst();
        if (alreadyReferenced !== undefined) throw new Error('MATERIAL_ALREADY_REFERENCED');
        await trx
          .insertInto('work_material')
          .values({
            work_id: work.id,
            material_id: replacement.id,
            user_id: userId,
            used_in: toJsonParam(usedIn),
          })
          .execute();
      }
      const affectsSlides = usedIn.some(
        (entry) => (entry as { target?: unknown } | null)?.target === 'slides',
      );
      await trx
        .deleteFrom('work_material')
        .where('work_id', '=', work.id)
        .where('material_id', '=', materialId)
        .where('user_id', '=', userId)
        .execute();

      if (!affectsSlides || latestAsset === undefined) return null;

      const lockedWork = await trx
        .selectFrom('work')
        .select(['active_render_job_id', 'step'])
        .where('id', '=', work.id)
        .where('user_id', '=', userId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (lockedWork.active_render_job_id !== null) {
        throw new RenderInProgressError(lockedWork.active_render_job_id);
      }

      const script = await this.scripts.forUser(userId).findLatest(work.id);
      if (script === null) throw new Error('SCRIPT_NOT_FOUND');

      const jobId = newId('job');
      const idempotencyKey = fingerprintOf({
        userId,
        workId: work.id,
        quality: 'patch',
        reason: 'compliance-material-change',
        materialId,
        replacementId,
        collectedAt: reference.collected_at,
        scriptVersion: script.row.version,
        templateId: latestAsset.template_id,
      });

      await trx
        .insertInto('render_job')
        .values({
          id: jobId,
          work_id: work.id,
          user_id: userId,
          type: 'patch',
          layer_scope: toJsonParam(['slides']),
          status: 'queued',
          progress: 0,
          stage: 'queued',
          cost_points: 0,
          reservation_id: null,
          video_asset_id: latestAsset.id,
          idempotency_key: idempotencyKey,
          attempt: 0,
          error: null,
          cancel_requested: 0,
        })
        .execute();
      const renderingStep = nextStep(lockedWork.step, 'hd:enqueued');
      await trx
        .updateTable('work')
        .set({
          active_render_job_id: jobId,
          step: renderingStep,
          phase: phaseOf(renderingStep),
          updated_at: nowLiteral(),
        })
        .where('id', '=', work.id)
        .execute();
      await enqueueInTransaction(trx, {
        queue: 'render.patch',
        jobId,
        userId,
        payload: { workId: work.id, quality: 'patch', scriptVersion: script.row.version },
        dedupKey: idempotencyKey,
      });
      return jobId;
    });

    if (result === null) return null;
    return RenderAccepted.parse({
      jobId: result,
      costPoints: 0,
      reservationId: null,
      quota: await readQuota(this.db, userId),
      sseUrl: `/api/jobs/${result}/events`,
    });
  }

  async detail(userId: string, jobId: string): Promise<RenderJobView> {
    const row = await this.db
      .selectFrom('render_job')
      .selectAll()
      .where('id', '=', jobId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (row === undefined) throw new RenderNotFoundError();
    const asset = row.video_asset_id
      ? await this.db
          .selectFrom('video_asset')
          .selectAll()
          .where('id', '=', row.video_asset_id)
          .where('user_id', '=', userId)
          .executeTakeFirst()
      : undefined;
    return {
      job: JobSchema.parse({
        id: row.id,
        workId: row.work_id,
        type: row.type,
        status: row.status,
        stage: stageLabel(row.stage),
        progress: row.progress,
        costPoints: row.cost_points,
        reservationId: row.reservation_id,
        attempt: row.attempt,
        error: row.error,
        createdAt: toRfc3339(row.created_at),
        updatedAt: toRfc3339(row.finished_at ?? row.started_at ?? row.created_at),
      }),
      videoUrl:
        asset?.storage_key == null
          ? null
          : await this.storage.presignGet({
              key: asset.storage_key,
              artifact: asset.quality === 'draft' ? 'draft' : 'video',
            }),
    };
  }

  async cancel(userId: string, jobId: string): Promise<Job> {
    const job = await this.db
      .selectFrom('render_job')
      .selectAll()
      .where('id', '=', jobId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (job === undefined) throw new RenderNotFoundError();
    const queue = await this.db
      .selectFrom('job_queue')
      .select('state')
      .where('job_id', '=', jobId)
      .executeTakeFirst();
    if ((job.status === 'queued' || job.status === 'running') && queue?.state === 'leased') {
      await this.db
        .updateTable('render_job')
        .set({ cancel_requested: 1 })
        .where('id', '=', jobId)
        .execute();
      await this.recordEvent(jobId, 'status', { status: 'canceling', reason: '用户取消渲染' });
      return (await this.detail(userId, jobId)).job;
    }
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('render_job')
        .set({
          status: 'canceled',
          cancel_requested: 1,
          finished_at: nowLiteral(),
        })
        .where('id', '=', jobId)
        .execute();
      if (job.reservation_id != null) {
        await releaseReservationIfHeld(trx, job.reservation_id, '用户取消渲染');
      }
      await trx
        .updateTable('job_queue')
        .set({ state: 'canceled', finished_at: nowLiteral() })
        .where('job_id', '=', jobId)
        .execute();
      const currentWork = await trx
        .selectFrom('work')
        .select('step')
        .where('id', '=', job.work_id)
        .executeTakeFirst();
      const draftStep = nextStep(currentWork?.step ?? 'video.draft', 'draft:succeeded');
      await trx
        .updateTable('work')
        .set({ active_render_job_id: null, step: draftStep, phase: phaseOf(draftStep) })
        .where('id', '=', job.work_id)
        .execute();
    });
    return (await this.detail(userId, jobId)).job;
  }

  async retry(userId: string, jobId: string): Promise<RenderAccepted> {
    const job = await this.db
      .selectFrom('render_job')
      .selectAll()
      .where('id', '=', jobId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (job === undefined) throw new RenderNotFoundError();
    if (job.status === 'queued' || job.status === 'running') {
      throw new RenderInProgressError(job.id);
    }
    const reservation = job.reservation_id
      ? await this.db
          .selectFrom('quota_reservation')
          .select(['id', 'state'])
          .where('id', '=', job.reservation_id)
          .executeTakeFirst()
      : undefined;
    const reservationId = await this.db.transaction().execute(async (trx) => {
      const nextReservationId =
        reservation?.state === 'held'
          ? reservation.id
          : await reserveQuotaInTransaction(trx, {
              userId,
              workId: job.work_id,
              jobId,
              points: job.cost_points,
            });
      await trx
        .updateTable('render_job')
        .set({
          status: 'queued',
          stage: 'queued',
          progress: 0,
          error: null,
          finished_at: null,
          cancel_requested: 0,
          reservation_id: nextReservationId,
        })
        .where('id', '=', jobId)
        .execute();
      if (job.video_asset_id != null) {
        await trx
          .updateTable('video_asset')
          .set({ status: 'queued', storage_key: null })
          .where('id', '=', job.video_asset_id)
          .execute();
      }
      const currentWork = await trx
        .selectFrom('work')
        .select('step')
        .where('id', '=', job.work_id)
        .executeTakeFirst();
      const retryStep = nextStep(currentWork?.step ?? 'video.draft', 'hd:enqueued');
      await trx
        .updateTable('work')
        .set({ active_render_job_id: jobId, step: retryStep, phase: phaseOf(retryStep) })
        .where('id', '=', job.work_id)
        .execute();
      await enqueueInTransaction(trx, {
        queue: `render.${job.type}`,
        jobId,
        userId,
        payload: { workId: job.work_id, quality: job.type },
        dedupKey: `${job.idempotency_key ?? jobId}:retry:${job.attempt + 1}`,
      });
      return nextReservationId;
    });
    return RenderAccepted.parse({
      jobId,
      costPoints: job.cost_points,
      reservationId,
      quota: await readQuota(this.db, userId),
      sseUrl: `/api/jobs/${jobId}/events`,
    });
  }

  async recordEvent(jobId: string, type: string, payload: Record<string, unknown>): Promise<void> {
    const row = await this.db
      .selectFrom('render_job_event')
      .select('seq')
      .where('job_id', '=', jobId)
      .orderBy('seq', 'desc')
      .limit(1)
      .executeTakeFirst();
    const seq = (row?.seq ?? -1) + 1;
    await this.db
      .insertInto('render_job_event')
      .values({ job_id: jobId, seq, event_type: type, payload: toJsonParam(payload) })
      .execute();
  }

  async listEvents(
    jobId: string,
    afterSeq: number,
  ): Promise<readonly { seq: number; event_type: string; payload: unknown }[]> {
    return this.db
      .selectFrom('render_job_event')
      .select(['seq', 'event_type', 'payload'])
      .where('job_id', '=', jobId)
      .where('seq', '>', afterSeq)
      .orderBy('seq', 'asc')
      .execute();
  }

  private async assertGateG2(_userId: string, work: WorkRow): Promise<void> {
    const snapshot = await this.snapshots.load(work);
    const gates = deriveGates(snapshot);
    if (!gates.G2) throw new RenderGateNotSatisfiedError();
  }

  private toContract(script: ScriptAggregate): Script {
    return {
      id: script.row.id,
      workId: script.row.work_id,
      version: script.row.version,
      status: script.row.status,
      confirmedAt: script.row.confirmed_at === null ? null : toRfc3339(script.row.confirmed_at),
      estimatedDuration: script.row.estimated_duration,
      actualDuration: script.row.actual_duration,
      sections: script.sections.map((section) => ({
        id: section.row.id,
        kind: section.row.kind,
        ord: section.row.ord,
        rangeStart: section.row.range_start,
        rangeEnd: section.row.range_end,
        lines: section.lines.map((line) => ({
          id: line.id,
          sectionId: line.section_id,
          ord: line.ord,
          text: line.text,
          editedByUser: line.edited_by_user === 1,
          charCount: line.char_count,
        })),
      })),
    };
  }
}
