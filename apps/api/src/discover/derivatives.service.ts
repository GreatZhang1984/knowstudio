import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  DerivativeSchema,
  type Derivative,
  RenderAccepted,
  type DeriveScope,
  type PlatformId,
  type PlatformRule,
  type TitleRegenerateResponse,
  type WorkEnvelope,
} from '@knowstudio/contracts';
import {
  generateDerivativeMetadata,
  regenerateDerivativeTitle,
} from '@knowstudio/ai';
import { toJsonParam, type Database, type Kysely } from '@knowstudio/db';
import { enqueueInTransaction } from '@knowstudio/queue';
import { readQuota } from '@knowstudio/quota';
import type { ScriptRepository, WorkRow } from '@knowstudio/db/repositories';
import type { ObjectStorage } from '@knowstudio/storage';
import { deriveGates, nextStep } from '@knowstudio/domain';
import { assembleWorkEnvelope } from '../works/work-envelope.js';
import type { WorkQuotaReader, WorkTruthSnapshotLoader } from '../works/work-ports.js';
import { WORK_QUOTA_READER, WORK_TRUTH_SNAPSHOT } from '../works/works.tokens.js';
import { DB_CLIENT, OBJECT_STORAGE } from '../shared/tokens.js';
import { SCRIPT_REPOSITORY } from './discover.tokens.js';

export class DerivativeGateNotSatisfiedError extends Error {
  readonly code = 'DERIVATIVE_GATE_NOT_SATISFIED';
  constructor(
    readonly requiredGate: 'G2' | 'G3',
    readonly reason: string,
    readonly redirectTo: string,
  ) {
    super('DERIVATIVE_GATE_NOT_SATISFIED');
    this.name = 'DerivativeGateNotSatisfiedError';
  }
}

interface RuleRow {
  readonly platform_id: string;
  readonly version: number;
  readonly title_max: number;
  readonly title_hard_max: number;
  readonly tag_max: number;
  readonly max_duration: number;
  readonly banned_patterns: unknown;
  readonly is_current: number;
}

interface DerivativeSnapshot {
  readonly id: string;
  readonly title: string;
  readonly tags: unknown;
  readonly rule_version: number;
}

export interface DerivativesView {
  readonly derivatives: readonly Derivative[];
  readonly envelope: WorkEnvelope;
}

function newJobId(): string {
  return `job_${randomUUID().replace(/-/g, '')}`;
}

function platformIdOf(value: string): PlatformId {
  if (value === 'douyin' || value === 'sph' || value === 'bili' || value === 'xhs') return value;
  throw new Error('PLATFORM_RULE_INVALID');
}

function bannedPatternsOf(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function validationOf(
  input: { title: string; tags: readonly string[] },
  rule: { titleMax: number; titleHardMax: number; tagMax: number; bannedPatterns: readonly string[] },
): { level: 'warn' | 'block'; field: string; message: string }[] {
  const result: { level: 'warn' | 'block'; field: string; message: string }[] = [];
  const titleLength = [...input.title].length;
  if (titleLength > rule.titleHardMax) {
    result.push({
      level: 'block',
      field: 'title',
      message: `标题超过硬上限 ${rule.titleHardMax} 字`,
    });
  } else if (titleLength > rule.titleMax) {
    result.push({ level: 'warn', field: 'title', message: `标题超过建议 ${rule.titleMax} 字` });
  }
  if (new Set(input.tags).size !== input.tags.length) {
    result.push({ level: 'warn', field: 'tags', message: '标签重复，发布前建议去重' });
  }
  if (input.tags.length > rule.tagMax) {
    result.push({
      level: 'block',
      field: 'tags',
      message: `标签最多 ${rule.tagMax} 个`,
    });
  }
  for (const pattern of rule.bannedPatterns) {
    if (pattern !== '' && input.title.includes(pattern)) {
      result.push({ level: 'block', field: 'title', message: `标题包含受限词：${pattern}` });
    }
  }
  return result;
}

@Injectable()
export class DerivativesService {
  constructor(
    @Inject(DB_CLIENT) private readonly db: Kysely<Database>,
    @Inject(SCRIPT_REPOSITORY) private readonly scripts: ScriptRepository,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(WORK_TRUTH_SNAPSHOT) private readonly snapshots: WorkTruthSnapshotLoader,
    @Inject(WORK_QUOTA_READER) private readonly quota: WorkQuotaReader,
  ) {}

  async generate(
    userId: string,
    work: WorkRow,
    input: { scope: DeriveScope; platformIds?: readonly PlatformId[] },
  ): Promise<DerivativesView | RenderAccepted> {
    await this.assertScope(work, input.scope);
    if (input.scope === 'media') {
      return this.enqueueMedia(userId, work, input.platformIds);
    }
    const script = await this.scripts.forUser(userId).findLatest(work.id);
    if (script === null) throw new Error('SCRIPT_NOT_FOUND');
    const hook = script.sections
      .flatMap((section) => section.lines)
      .find((line) => line.text.trim() !== '')
      ?.text;
    const rules = await this.currentRules(input.platformIds);
    const generated = generateDerivativeMetadata({
      keyword: work.keyword ?? work.title,
      hook: hook ?? work.title,
      rules: rules.map((rule) => ({
        platformId: rule.platformId,
        titleMax: rule.titleMax,
        tagMax: rule.tagMax,
        maxDurationSec: rule.maxDurationSec,
      })),
    });

    for (const item of generated) {
      const rule = rules.find((candidate) => candidate.platformId === item.platformId);
      if (rule === undefined) throw new Error('PLATFORM_RULE_MISSING');
      const validation = validationOf(item, rule);
      await this.db
        .insertInto('derivative')
        .values({
          id: `dv_${randomUUID().replace(/-/g, '')}`,
          work_id: work.id,
          user_id: userId,
          platform_id: item.platformId,
          title: item.title,
          tags: toJsonParam([...item.tags]),
          duration_version: item.durationVersion,
          cover_layer_id: null,
          video_asset_id: null,
          rule_version: rule.version,
          metadata_ready: 1,
          media_ready: 0,
          validation: toJsonParam(validation),
        })
        .onDuplicateKeyUpdate({
          title: item.title,
          tags: toJsonParam([...item.tags]),
          duration_version: item.durationVersion,
          rule_version: rule.version,
          metadata_ready: 1,
          media_ready: 0,
          validation: toJsonParam(validation),
        })
        .execute();
    }
    return this.responseFor(userId, work);
  }

  private async enqueueMedia(
    userId: string,
    work: WorkRow,
    platformIds?: readonly PlatformId[],
  ): Promise<RenderAccepted> {
    const derivatives = await this.db
      .selectFrom('derivative')
      .selectAll()
      .where('work_id', '=', work.id)
      .where('user_id', '=', userId)
      .execute();
    const selected =
      platformIds === undefined
        ? derivatives
        : derivatives.filter((row) => platformIds.includes(platformIdOf(row.platform_id)));
    if (platformIds !== undefined && selected.length !== platformIds.length) {
      throw new Error('DERIVATIVE_METADATA_REQUIRED');
    }
    if (selected.length === 0 || selected.some((row) => row.metadata_ready !== 1)) {
      throw new Error('DERIVATIVE_METADATA_REQUIRED');
    }
    const blocked = selected.find((row) =>
      Array.isArray(row.validation)
        ? row.validation.some(
            (item) =>
              typeof item === 'object' &&
              item !== null &&
              'level' in item &&
              item.level === 'block',
          )
        : false,
    );
    if (blocked !== undefined) throw new Error('DERIVATIVE_VALIDATION_BLOCKED');

    const active = await this.db
      .selectFrom('render_job')
      .select('id')
      .where('work_id', '=', work.id)
      .where('type', '=', 'derive_media')
      .where('status', 'in', ['queued', 'running'])
      .executeTakeFirst();
    if (active !== undefined) throw new Error('DERIVATIVE_MEDIA_IN_PROGRESS');

    const jobId = newJobId();
    const platforms = selected.map((row) => platformIdOf(row.platform_id));
    await this.db.transaction().execute(async (trx) => {
      await trx
        .insertInto('render_job')
        .values({
          id: jobId,
          work_id: work.id,
          user_id: userId,
          type: 'derive_media',
          layer_scope: toJsonParam(platforms),
          status: 'queued',
          progress: 0,
          stage: 'queued',
          cost_points: 0,
          reservation_id: null,
          video_asset_id: null,
          idempotency_key: null,
          attempt: 0,
          error: null,
          cancel_requested: 0,
        })
        .execute();
      await enqueueInTransaction(trx, {
        queue: 'derive.media',
        jobId,
        userId,
        payload: { workId: work.id, platformIds: platforms },
        dedupKey: `derive-media:${work.id}:${platforms.join(',')}:${Date.now()}`,
      });
    });
    return RenderAccepted.parse({
      jobId,
      costPoints: 0,
      reservationId: null,
      quota: await readQuota(this.db, userId),
      sseUrl: `/api/jobs/${jobId}/events`,
    });
  }

  async list(userId: string, work: WorkRow): Promise<DerivativesView> {
    return this.responseFor(userId, work, false);
  }

  async patch(
    userId: string,
    work: WorkRow,
    platformId: PlatformId,
    input: { title?: string; tags?: readonly string[]; durationVersion?: 'full' | 'essence30' | 'teaser15' },
  ): Promise<DerivativesView> {
    await this.assertScope(work, 'metadata');
    const row = await this.findRow(userId, work.id, platformId);
    const rule = await this.ruleFor(platformId);
    const title = input.title ?? row.title;
    const tags: string[] =
      input.tags === undefined ? (Array.isArray(row.tags) ? row.tags : []) : [...input.tags];
    if (title.trim() === '') throw new Error('DERIVATIVE_TITLE_REQUIRED');
    const validation = validationOf({ title, tags }, rule);
    await this.db
      .updateTable('derivative')
      .set({
        title,
        tags: toJsonParam([...tags]),
        ...(input.durationVersion === undefined
          ? {}
          : { duration_version: input.durationVersion }),
        metadata_ready: 1,
        validation: toJsonParam(validation),
      })
      .where('id', '=', row.id)
      .execute();
    return this.responseFor(userId, work);
  }

  async regenerateTitle(
    userId: string,
    work: WorkRow,
    platformId: PlatformId,
  ): Promise<TitleRegenerateResponse> {
    await this.assertScope(work, 'metadata');
    const row = await this.findRow(userId, work.id, platformId);
    const rule = await this.ruleFor(platformId);
    const script = await this.scripts.forUser(userId).findLatest(work.id);
    if (script === null) throw new Error('SCRIPT_NOT_FOUND');
    const hook =
      script.sections
        .flatMap((section) => section.lines)
        .find((line) => line.text.trim() !== '')
        ?.text ?? work.title;
    const title = regenerateDerivativeTitle(work.keyword ?? work.title, hook, platformId);
    const tags: string[] = Array.isArray(row.tags) ? row.tags : [];
    const validation = validationOf({ title, tags }, rule);
    await this.db
      .updateTable('derivative')
      .set({ title, metadata_ready: 1, validation: toJsonParam(validation) })
      .where('id', '=', row.id)
      .execute();
    const updated = await this.db
      .selectFrom('derivative')
      .selectAll()
      .where('id', '=', row.id)
      .executeTakeFirst();
    if (updated === undefined) throw new Error('DERIVATIVE_NOT_FOUND');
    return {
      derivative: await this.toContract(updated),
      envelope: await this.envelopeFor(userId, work),
    };
  }

  private async assertScope(work: WorkRow, scope: DeriveScope): Promise<void> {
    const snapshot = await this.snapshots.load(work);
    const gates = deriveGates(snapshot);
    const required = scope === 'metadata' ? gates.G2 : gates.G3;
    if (required) return;
    if (scope === 'metadata') {
      throw new DerivativeGateNotSatisfiedError(
        'G2',
        'SCRIPT_NOT_CONFIRMED',
        `/studio/${work.id}/script`,
      );
    }
    throw new DerivativeGateNotSatisfiedError(
      'G3',
      work.active_render_job_id == null ? 'HD_RENDER_NOT_SUCCEEDED' : 'HD_RENDER_IN_PROGRESS',
      work.active_render_job_id == null
        ? `/studio/${work.id}/video`
        : `/studio/${work.id}/render`,
    );
  }

  private async currentRules(
    platformIds?: readonly PlatformId[],
  ): Promise<PlatformRule[]> {
    const rows = await this.db
      .selectFrom('platform_rule')
      .selectAll()
      .where('is_current', '=', 1)
      .orderBy('platform_id', 'asc')
      .execute();
    return rows
      .map((row) => this.toRule(row))
      .filter((rule) => platformIds === undefined || platformIds.includes(rule.platformId));
  }

  private async ruleFor(platformId: PlatformId): Promise<PlatformRule> {
    const row = await this.db
      .selectFrom('platform_rule')
      .selectAll()
      .where('platform_id', '=', platformId)
      .where('is_current', '=', 1)
      .executeTakeFirst();
    if (row === undefined) throw new Error('PLATFORM_RULE_NOT_FOUND');
    return this.toRule(row);
  }

  private toRule(row: RuleRow): PlatformRule {
    return {
      platformId: platformIdOf(row.platform_id),
      version: row.version,
      name: '',
      ratio: '',
      isCurrent: row.is_current === 1,
      titleMax: row.title_max,
      titleHardMax: row.title_hard_max,
      tagMax: row.tag_max,
      maxDurationSec: row.max_duration,
      orient: 'vertical',
      brandColor: '',
      styleHint: '',
      bannedPatterns: [...bannedPatternsOf(row.banned_patterns)],
      updatedAt: '1970-01-01T00:00:00Z',
    };
  }

  private async findRow(
    userId: string,
    workId: string,
    platformId: PlatformId,
  ): Promise<DerivativeSnapshot> {
    const row = await this.db
      .selectFrom('derivative')
      .select(['id', 'title', 'tags', 'rule_version'])
      .where('work_id', '=', workId)
      .where('user_id', '=', userId)
      .where('platform_id', '=', platformId)
      .executeTakeFirst();
    if (row === undefined) throw new Error('DERIVATIVE_NOT_FOUND');
    return row;
  }

  private async responseFor(
    userId: string,
    work: WorkRow,
    advanceStep = true,
  ): Promise<DerivativesView> {
    const rows = await this.db
      .selectFrom('derivative')
      .selectAll()
      .where('work_id', '=', work.id)
      .where('user_id', '=', userId)
      .orderBy('platform_id', 'asc')
      .execute();
    if (advanceStep && rows.length === 4 && rows.every((row) => row.metadata_ready === 1)) {
      const step = nextStep(work.step, 'derive:metadataReady');
      await this.db
        .updateTable('work')
        .set({ step, phase: 3, updated_at: new Date().toISOString().replace('T', ' ').replace('Z', '') })
        .where('id', '=', work.id)
        .execute();
      return {
        derivatives: await Promise.all(rows.map((row) => this.toContract(row))),
        envelope: await this.envelopeFor(userId, { ...work, step, phase: 3 }),
      };
    }
    return {
      derivatives: await Promise.all(rows.map((row) => this.toContract(row))),
      envelope: await this.envelopeFor(userId, work),
    };
  }

  private async envelopeFor(userId: string, work: WorkRow): Promise<WorkEnvelope> {
    const [snapshot, quota] = await Promise.all([
      this.snapshots.load(work),
      this.quota.readForUser(userId),
    ]);
    return assembleWorkEnvelope(work, snapshot, quota);
  }

  private async toContract(row: {
    id: string;
    work_id: string;
    platform_id: string;
    title: string;
    tags: unknown;
    duration_version: 'full' | 'essence30' | 'teaser15';
    cover_layer_id: string | null;
    video_asset_id: string | null;
    rule_version: number;
    metadata_ready: number;
    media_ready: number;
    validation: unknown;
  }): Promise<Derivative> {
    let mediaUrl: string | null = null;
    if (row.video_asset_id !== null) {
      const asset = await this.db
        .selectFrom('video_asset')
        .select(['storage_key', 'quality'])
        .where('id', '=', row.video_asset_id)
        .executeTakeFirst();
      if (asset?.storage_key != null) {
        mediaUrl = await this.storage.presignGet({
          key: asset.storage_key,
          artifact: asset.quality === 'draft' ? 'draft' : 'video',
        });
      }
    }
    return DerivativeSchema.parse({
      id: row.id,
      workId: row.work_id,
      platformId: platformIdOf(row.platform_id),
      title: row.title,
      tags: Array.isArray(row.tags) ? row.tags.filter((tag): tag is string => typeof tag === 'string') : [],
      durationVersion: row.duration_version,
      coverLayerId: row.cover_layer_id,
      videoAssetId: row.video_asset_id,
      mediaUrl,
      ruleVersion: row.rule_version,
      metadataReady: row.metadata_ready === 1,
      mediaReady: row.media_ready === 1,
      validation: Array.isArray(row.validation) ? row.validation : [],
    });
  }
}
