import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { ZipArchive } from 'archiver';
import { createDb, dbConfigFromEnv, toJsonParam, type Database, type Kysely } from '@knowstudio/db';
import { createScriptRepository, type ScriptAggregate } from '@knowstudio/db/repositories';
import { createLocalStorage, exportKey, layerKey, videoKey } from '@knowstudio/storage';
import {
  cancelClaimedJob,
  claimJob,
  completeClaimedJob,
  completeJob,
  enqueueInTransaction,
  failJob,
  recoverExpiredLeases,
  renewLease,
  type ClaimedJob,
} from '@knowstudio/queue';
import { computeMetricSnapshots, createAnalyticsRecorder } from '@knowstudio/observability';
import { commitQuotaInTransaction, releaseQuotaInTransaction } from '@knowstudio/quota';
import {
  buildLayerPlan,
  clipTimeline,
  coverSvg,
  fingerprint,
  synthesizeAudio,
  renderVideo,
  timelineOf,
} from '@knowstudio/media';
import { nextStep, phaseOf } from '@knowstudio/domain';
import type { Script } from '@knowstudio/contracts';

const owner = `${process.env['COMPUTERNAME'] ?? 'worker'}-${process.pid}-${randomUUID()}`;

function nowLiteral(): string {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

function toContract(script: ScriptAggregate): Script {
  return {
    id: script.row.id,
    workId: script.row.work_id,
    version: script.row.version,
    status: script.row.status,
    confirmedAt:
      script.row.confirmed_at === null ? null : `${script.row.confirmed_at.replace(' ', 'T')}Z`,
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

async function event(
  db: Kysely<Database>,
  jobId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const row = await db
    .selectFrom('render_job_event')
    .select('seq')
    .where('job_id', '=', jobId)
    .orderBy('seq', 'desc')
    .limit(1)
    .executeTakeFirst();
  const seq = (row?.seq ?? -1) + 1;
  await db
    .insertInto('render_job_event')
    .values({ job_id: jobId, seq, event_type: type, payload: toJsonParam(payload) })
    .execute();
}

async function analyticsEvent(
  db: Kysely<Database>,
  input: Parameters<ReturnType<typeof createAnalyticsRecorder>['record']>[0],
): Promise<void> {
  await createAnalyticsRecorder(db).record(input);
}

async function releaseAfterFailure(
  db: Kysely<Database>,
  jobId: string,
  reason: string,
): Promise<void> {
  const job = await db
    .selectFrom('render_job')
    .selectAll()
    .where('id', '=', jobId)
    .executeTakeFirst();
  if (job === undefined) return;
  await db.transaction().execute(async (trx) => {
    if (job.reservation_id != null)
      await releaseQuotaInTransaction(trx, job.reservation_id, reason);
    await trx
      .updateTable('render_job')
      .set({
        status: 'failed',
        stage: 'finalize',
        error: toJsonParam({
          layer: null,
          code: 'WORKER_FAILED',
          message: reason,
          retryable: true,
        }),
        finished_at: new Date().toISOString().replace('T', ' ').replace('Z', ''),
      })
      .where('id', '=', jobId)
      .execute();
    if (job.video_asset_id != null) {
      await trx
        .updateTable('video_asset')
        .set({ status: 'failed' })
        .where('id', '=', job.video_asset_id)
        .execute();
    }
    await settleWorkStep(trx, job.work_id, null);
  });
}

async function releaseIfHeld(
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

async function finalizeCancellation(
  db: Kysely<Database>,
  jobId: string,
  reason: string,
): Promise<void> {
  const job = await db
    .selectFrom('render_job')
    .selectAll()
    .where('id', '=', jobId)
    .executeTakeFirst();
  if (job === undefined || job.status === 'canceled') return;
  await db.transaction().execute(async (trx) => {
    const locked = await trx
      .selectFrom('render_job')
      .selectAll()
      .where('id', '=', jobId)
      .forUpdate()
      .executeTakeFirst();
    if (locked === undefined || locked.status === 'canceled') return;
    if (locked.reservation_id != null) {
      await releaseIfHeld(trx, locked.reservation_id, reason);
    }
    await trx
      .updateTable('render_job')
      .set({ status: 'canceled', stage: 'finalize', finished_at: nowLiteral() })
      .where('id', '=', jobId)
      .execute();
    if (locked.video_asset_id != null) {
      await trx
        .updateTable('video_asset')
        .set({ status: 'canceled' })
        .where('id', '=', locked.video_asset_id)
        .execute();
    }
    await settleWorkStep(trx, locked.work_id, null);
  });
  await event(db, jobId, 'status', { status: 'canceled', reason });
}

export async function reconcileRenderJobs(db: Kysely<Database>): Promise<void> {
  const jobs = await db
    .selectFrom('render_job')
    .selectAll()
    .where('status', 'in', ['queued', 'running'])
    .where('type', 'in', ['draft', 'hd', 'patch'])
    .execute();
  if (jobs.length === 0) return;
  const queues = await db
    .selectFrom('job_queue')
    .selectAll()
    .where(
      'job_id',
      'in',
      jobs.map((job) => job.id),
    )
    .execute();
  const queueByJob = new Map(queues.map((queue) => [queue.job_id, queue]));

  for (const job of jobs) {
    const queue = queueByJob.get(job.id);
    if (queue === undefined) {
      await db.transaction().execute(async (trx) => {
        await enqueueInTransaction(trx, {
          queue: `render.${job.type}`,
          jobId: job.id,
          userId: job.user_id,
          payload: { workId: job.work_id, quality: job.type },
          dedupKey: `${job.idempotency_key ?? job.id}:reconcile`,
        });
      });
      continue;
    }
    if (queue.state === 'dead') {
      await releaseAfterFailure(db, job.id, 'queue reached dead letter');
      continue;
    }
    if (queue.state === 'canceled') {
      await finalizeCancellation(db, job.id, 'queue canceled');
      continue;
    }
    if (queue.state === 'done') {
      await db
        .updateTable('job_queue')
        .set({ state: 'pending', run_after: nowLiteral(), lease_owner: null })
        .where('id', '=', queue.id)
        .execute();
    }
  }
}

async function cancellationRequested(db: Kysely<Database>, jobId: string): Promise<boolean> {
  const row = await db
    .selectFrom('render_job')
    .select('cancel_requested')
    .where('id', '=', jobId)
    .executeTakeFirst();
  return row?.cancel_requested === 1;
}

function durationLimitMs(durationVersion: string, ruleMaxSec: number): number | null {
  const selected =
    durationVersion === 'teaser15' ? 15_000 : durationVersion === 'essence30' ? 30_000 : null;
  const ruleMax = ruleMaxSec * 1000;
  return selected === null ? ruleMax : Math.min(selected, ruleMax);
}

type BusinessClaimedJob = ClaimedJob & { readonly jobId: string; readonly userId: string };
let scheduledMetricBucket = '';

async function runDerivationClaim(
  db: Kysely<Database>,
  queueJob: BusinessClaimedJob,
): Promise<void> {
  const timer = setInterval(() => void renewLease(db, queueJob.jobId, owner, queueJob.leaseToken), 1_000);
  try {
    if (await cancellationRequested(db, queueJob.jobId)) {
      await finalizeCancellation(db, queueJob.jobId, '用户取消派生');
      await cancelClaimedJob(db, queueJob.jobId, owner, queueJob.leaseToken);
      return;
    }
    await event(db, queueJob.jobId, 'status', { status: 'running' });
    const jobRow = await db
      .selectFrom('render_job')
      .selectAll()
      .where('id', '=', queueJob.jobId)
      .executeTakeFirstOrThrow();
    await db
      .updateTable('render_job')
      .set({
        status: 'running',
        stage: 'mux',
        attempt: queueJob.attempt + 1,
        started_at: jobRow.started_at ?? nowLiteral(),
      })
      .where('id', '=', queueJob.jobId)
      .where('status', 'in', ['queued', 'running'])
      .execute();

    const payloadPlatforms = Array.isArray(queueJob.payload['platformIds'])
      ? queueJob.payload['platformIds'].filter((id): id is string => typeof id === 'string')
      : [];
    const [script, rules] = await Promise.all([
      createScriptRepository(db).forUser(queueJob.userId).findLatest(jobRow.work_id),
      db
        .selectFrom('platform_rule')
        .selectAll()
        .where('is_current', '=', 1)
        .where('platform_id', 'in', payloadPlatforms.length > 0 ? payloadPlatforms : ['-'])
        .execute(),
    ]);
    if (script === null) throw new Error('SCRIPT_NOT_FOUND');
    const scriptContract = toContract(script);
    const masterTimeline = timelineOf(scriptContract);
    const masterHd = await db
      .selectFrom('video_asset')
      .selectAll()
      .where('work_id', '=', jobRow.work_id)
      .where('user_id', '=', queueJob.userId)
      .where('quality', '=', 'hd')
      .where('status', '=', 'succeeded')
      .orderBy('created_at', 'desc')
      .executeTakeFirst();
    if (masterHd === undefined || masterHd.script_version !== script.row.version) {
      throw new Error('HD_MASTER_MISSING');
    }
    const derivatives = await db
      .selectFrom('derivative')
      .selectAll()
      .where('work_id', '=', jobRow.work_id)
      .where('user_id', '=', queueJob.userId)
      .where('platform_id', 'in', payloadPlatforms.length > 0 ? payloadPlatforms : ['-'])
      .execute();
    if (derivatives.length === 0) throw new Error('DERIVATIVE_METADATA_REQUIRED');
    const audioFingerprint = fingerprint({
      scriptVersion: script.row.version,
      voiceId: masterHd.voice_id ?? 'voice_steady_male',
      speed: Number(masterHd.speed),
      kind: 'audio',
    });
    const audioLayer = await db
      .selectFrom('asset_layer')
      .select(['id', 'storage_key'])
      .where('work_id', '=', jobRow.work_id)
      .where('kind', '=', 'audio')
      .where('input_fingerprint', '=', audioFingerprint)
      .orderBy('created_at', 'desc')
      .executeTakeFirst();
    if (audioLayer === undefined) throw new Error('AUDIO_LAYER_MISSING');
    const storage = createLocalStorage({
      endpoint: '',
      region: '',
      bucket: '',
      accessKeyId: '',
      secretAccessKey: '',
      root: process.env['LOCAL_STORAGE_ROOT'] ?? resolve(process.cwd(), '.local-storage'),
    });
    const audio = (await storage.getObject(audioLayer.storage_key)).body;

    for (const [index, derivative] of derivatives.entries()) {
      if (await cancellationRequested(db, queueJob.jobId)) {
        await finalizeCancellation(db, queueJob.jobId, '用户取消派生');
        await cancelClaimedJob(db, queueJob.jobId, owner, queueJob.leaseToken);
        return;
      }
      const rule = rules.find((row) => row.platform_id === derivative.platform_id);
      if (rule === undefined) throw new Error('PLATFORM_RULE_MISSING');
      await event(db, queueJob.jobId, 'progress', {
        stage: 'mux',
        progress: Math.round((index / derivatives.length) * 90),
        platformId: derivative.platform_id,
      });
      const maxDurationMs = durationLimitMs(derivative.duration_version, rule.max_duration);
      const platformTimeline = clipTimeline(masterTimeline, maxDurationMs);
      const coverBytes = new TextEncoder().encode(
        coverSvg({
          title: derivative.title,
          platformId: derivative.platform_id,
          brandColor: rule.brand_color,
          orient: rule.orient,
        }),
      );
      const video = await renderVideo({
        audio,
        timeline: platformTimeline,
        quality: 'hd',
        orient: rule.orient,
        maxDurationMs: maxDurationMs ?? undefined,
      });
      const videoKeyName = videoKey({
        userId: queueJob.userId,
        workId: jobRow.work_id,
        variant: `platform-${derivative.platform_id}`,
      });
      await storage.putObject({
        key: videoKeyName,
        body: video,
        contentType: 'video/mp4',
        artifact: 'video',
      });

      await db.transaction().execute(async (trx) => {
        const coverVersion = await nextLayerVersion(trx, jobRow.work_id, 'cover');
        const coverKey = layerKey({
          userId: queueJob.userId,
          workId: jobRow.work_id,
          kind: 'cover',
          version: coverVersion,
        });
        await storage.putObject({
          key: coverKey,
          body: coverBytes,
          contentType: 'image/svg+xml',
          artifact: 'layer',
        });
        const coverId = `al_${randomUUID().replace(/-/g, '')}`;
        await trx
          .insertInto('asset_layer')
          .values({
            id: coverId,
            work_id: jobRow.work_id,
            user_id: queueJob.userId,
            kind: 'cover',
            version: coverVersion,
            content_hash: fingerprint(Array.from(coverBytes, (byte) => byte.toString(16).padStart(2, '0')).join('')),
            storage_key: coverKey,
            meta: toJsonParam({
              platformId: derivative.platform_id,
              ruleVersion: rule.version,
              title: derivative.title,
            }),
            input_fingerprint: fingerprint({
              workId: jobRow.work_id,
              platformId: derivative.platform_id,
              title: derivative.title,
              tags: derivative.tags,
              ruleVersion: rule.version,
              kind: 'cover',
            }),
            duration_ms: platformTimeline.at(-1)?.endMs ?? null,
          })
          .execute();

        const assetId = derivative.video_asset_id ?? `va_${randomUUID().replace(/-/g, '')}`;
        if (derivative.video_asset_id === null) {
          await trx
            .insertInto('video_asset')
            .values({
              id: assetId,
              work_id: jobRow.work_id,
              user_id: queueJob.userId,
              quality: 'hd',
              status: 'succeeded',
              storage_key: videoKeyName,
              duration_ms: platformTimeline.at(-1)?.endMs ?? maxDurationMs,
              resolution: rule.orient === 'horizontal' ? '1920x1080' : '1080x1920',
              orient: rule.orient,
              template_id: masterHd.template_id,
              voice_id: masterHd.voice_id,
              speed: masterHd.speed,
              script_version: script.row.version,
            })
            .execute();
        } else {
          await trx
            .updateTable('video_asset')
            .set({
              status: 'succeeded',
              storage_key: videoKeyName,
              duration_ms: platformTimeline.at(-1)?.endMs ?? maxDurationMs,
              resolution: rule.orient === 'horizontal' ? '1920x1080' : '1080x1920',
              orient: rule.orient,
              stale: 0,
              script_version: script.row.version,
            })
            .where('id', '=', assetId)
            .execute();
        }
        for (const layerId of [coverId, audioLayer.id]) {
          await trx
            .insertInto('video_asset_layer')
            .values({ video_asset_id: assetId, layer_id: layerId })
            .onDuplicateKeyUpdate({ layer_id: layerId })
            .execute();
        }
        await trx
          .updateTable('derivative')
          .set({
            cover_layer_id: coverId,
            video_asset_id: assetId,
            media_ready: 1,
          })
          .where('id', '=', derivative.id)
          .execute();
        await trx
          .updateTable('render_job')
          .set({ progress: Math.round(((index + 1) / derivatives.length) * 90) })
          .where('id', '=', queueJob.jobId)
          .execute();
      });
    }

    if (await cancellationRequested(db, queueJob.jobId)) {
      await finalizeCancellation(db, queueJob.jobId, '用户取消派生');
      await cancelClaimedJob(db, queueJob.jobId, owner, queueJob.leaseToken);
      return;
    }
    await db
      .updateTable('render_job')
      .set({ status: 'succeeded', stage: 'finalize', progress: 100, finished_at: nowLiteral() })
      .where('id', '=', queueJob.jobId)
      .execute();
    for (const derivative of derivatives) {
      await analyticsEvent(db, {
        userId: queueJob.userId,
        workId: jobRow.work_id,
        event: 'derivative_generated',
        props: { derivativeId: derivative.id, platformId: derivative.platform_id, scope: 'media' },
      });
    }
    await event(db, queueJob.jobId, 'done', { redirectTo: `/publish/${jobRow.work_id}` });
    const completed = await completeJob(db, queueJob.jobId, owner, queueJob.leaseToken);
    if (!completed) throw new Error('QUEUE_FENCING_REJECTED');
  } catch (error) {
    if (await cancellationRequested(db, queueJob.jobId)) {
      await finalizeCancellation(db, queueJob.jobId, '用户取消派生');
      await cancelClaimedJob(db, queueJob.jobId, owner, queueJob.leaseToken);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    await event(db, queueJob.jobId, 'error', { code: 'WORKER_FAILED', message });
    const outcome = await failJob(db, queueJob.jobId, owner, queueJob.leaseToken, {
      code: 'WORKER_FAILED',
      message,
    });
    if (outcome === 'dead') await releaseAfterFailure(db, queueJob.jobId, message);
  } finally {
    clearInterval(timer);
  }
}

interface ExportFileRecord {
  readonly platformId: string | null;
  readonly kind: 'package' | 'video' | 'cover' | 'manifest' | 'checklist';
  readonly key: string;
  readonly bytes: number;
  readonly durationMs: number | null;
  readonly path: string;
}

async function runExportClaim(
  db: Kysely<Database>,
  queueJob: BusinessClaimedJob,
): Promise<void> {
  const timer = setInterval(() => void renewLease(db, queueJob.jobId, owner, queueJob.leaseToken), 1_000);
  try {
    const jobRow = await db
      .selectFrom('render_job')
      .selectAll()
      .where('id', '=', queueJob.jobId)
      .executeTakeFirstOrThrow();
    const exportId = String(queueJob.payload['exportId'] ?? '');
    const packageRow = await db
      .selectFrom('export_package')
      .selectAll()
      .where('id', '=', exportId)
      .executeTakeFirstOrThrow();
    await event(db, queueJob.jobId, 'status', { status: 'running' });
    await db
      .updateTable('render_job')
      .set({
        status: 'running',
        stage: 'package',
        attempt: queueJob.attempt + 1,
        started_at: jobRow.started_at ?? nowLiteral(),
      })
      .where('id', '=', queueJob.jobId)
      .execute();
    await db
      .updateTable('export_package')
      .set({ status: 'running' })
      .where('id', '=', exportId)
      .execute();

    const [work, report, derivatives, rules] = await Promise.all([
      db
        .selectFrom('work')
        .select(['id', 'title', 'keyword'])
        .where('id', '=', jobRow.work_id)
        .where('user_id', '=', queueJob.userId)
        .executeTakeFirstOrThrow(),
      db
        .selectFrom('compliance_report')
        .selectAll()
        .where('id', '=', packageRow.report_id ?? '')
        .executeTakeFirstOrThrow(),
      db
        .selectFrom('derivative')
        .selectAll()
        .where('work_id', '=', jobRow.work_id)
        .where('user_id', '=', queueJob.userId)
        .execute(),
      db
        .selectFrom('platform_rule')
        .selectAll()
        .where('is_current', '=', 1)
        .execute(),
    ]);
    if (derivatives.length !== 4 || derivatives.some((row) => row.media_ready !== 1)) {
      throw new Error('EXPORT_MEDIA_NOT_READY');
    }

    const storage = createLocalStorage({
      endpoint: '',
      region: '',
      bucket: '',
      accessKeyId: '',
      secretAccessKey: '',
      root: process.env['LOCAL_STORAGE_ROOT'] ?? resolve(process.cwd(), '.local-storage'),
    });
    const prefix = exportKey({
      userId: queueJob.userId,
      workId: jobRow.work_id,
      exportId,
    });
    const manifestKey = `${prefix}/manifest.json`;
    const checklistKey = `${prefix}/发布清单.md`;
    const packageKey = `${prefix}/package.zip`;
    const files: ExportFileRecord[] = [];
    const zipEntries: { name: string; body: Uint8Array }[] = [];

    for (const derivative of derivatives) {
      if (derivative.video_asset_id === null || derivative.cover_layer_id === null) {
        throw new Error('EXPORT_DERIVATIVE_INCOMPLETE');
      }
      const [videoAsset, coverLayer] = await Promise.all([
        db
          .selectFrom('video_asset')
          .select(['id', 'storage_key', 'duration_ms'])
          .where('id', '=', derivative.video_asset_id)
          .where('user_id', '=', queueJob.userId)
          .where('status', '=', 'succeeded')
          .executeTakeFirstOrThrow(),
        db
          .selectFrom('asset_layer')
          .select(['id', 'storage_key'])
          .where('id', '=', derivative.cover_layer_id)
          .where('user_id', '=', queueJob.userId)
          .executeTakeFirstOrThrow(),
      ]);
      if (videoAsset.storage_key === null || coverLayer.storage_key === null) {
        throw new Error('EXPORT_STORAGE_KEY_MISSING');
      }
      const [video, cover] = await Promise.all([
        storage.getObject(videoAsset.storage_key),
        storage.getObject(coverLayer.storage_key),
      ]);
      const videoPath = `${derivative.platform_id}/video.mp4`;
      const coverPath = `${derivative.platform_id}/cover.svg`;
      zipEntries.push(
        { name: videoPath, body: video.body },
        { name: coverPath, body: cover.body },
      );
      files.push(
        {
          platformId: derivative.platform_id,
          kind: 'video',
          key: videoAsset.storage_key,
          bytes: video.body.byteLength,
          durationMs: videoAsset.duration_ms,
          path: videoPath,
        },
        {
          platformId: derivative.platform_id,
          kind: 'cover',
          key: coverLayer.storage_key,
          bytes: cover.body.byteLength,
          durationMs: videoAsset.duration_ms,
          path: coverPath,
        },
      );
    }

    const manifest = {
      exportId,
      workId: work.id,
      title: work.title,
      keyword: work.keyword,
      compliance: {
        reportId: report.id,
        fingerprint: report.fingerprint,
        blockingCount: report.blocking_count,
        warnCount: report.warn_count,
      },
      platforms: derivatives.map((derivative) => {
        const video = files.find((file) => file.platformId === derivative.platform_id && file.kind === 'video');
        const cover = files.find((file) => file.platformId === derivative.platform_id && file.kind === 'cover');
        return {
          platformId: derivative.platform_id,
          ruleVersion: derivative.rule_version,
          title: derivative.title,
          tags: derivative.tags,
          durationVersion: derivative.duration_version,
          durationMs: video?.durationMs ?? null,
          video: video?.path ?? null,
          cover: cover?.path ?? null,
        };
      }),
    };
    const manifestBytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
    const checklistBytes = new TextEncoder().encode(
      [
        `# ${work.title} 发布清单`,
        '',
        `- 关键词：${work.keyword}`,
        `- 导出包：${exportId}`,
        `- 合规报告：${report.id}（阻断 ${report.blocking_count} 项）`,
        '- 发布方式：需你本人登录各平台手动发布，本系统不会自动发布。',
        '',
        ...derivatives.map((derivative) => {
          const rule = rules.find((item) => item.platform_id === derivative.platform_id);
          const video = files.find(
            (file) => file.platformId === derivative.platform_id && file.kind === 'video',
          );
          return [
            `## ${rule?.name ?? derivative.platform_id}`,
            '',
            `- 标题：${derivative.title}`,
            `- 标签：${derivative.tags.join('、')}`,
            `- 时长版本：${derivative.duration_version}`,
            `- 时长：${Math.round((video?.durationMs ?? 0) / 1000)} 秒`,
            `- 成片：${video?.path ?? ''}`,
            `- 规则版本：${derivative.rule_version}`,
            '',
          ].join('\n');
        }),
      ].join('\n'),
    );
    zipEntries.push(
      { name: 'manifest.json', body: manifestBytes },
      { name: '发布清单.md', body: checklistBytes },
    );
    await storage.putObject({
      key: manifestKey,
      body: manifestBytes,
      contentType: 'application/json',
      artifact: 'export',
    });
    await storage.putObject({
      key: checklistKey,
      body: checklistBytes,
      contentType: 'text/markdown; charset=utf-8',
      artifact: 'export',
    });
    files.push(
      {
        platformId: null,
        kind: 'manifest',
        key: manifestKey,
        bytes: manifestBytes.byteLength,
        durationMs: null,
        path: 'manifest.json',
      },
      {
        platformId: null,
        kind: 'checklist',
        key: checklistKey,
        bytes: checklistBytes.byteLength,
        durationMs: null,
        path: '发布清单.md',
      },
    );

    await event(db, queueJob.jobId, 'progress', { stage: 'package', progress: 40 });
    const archive = new ZipArchive({ store: true });
    for (const entry of zipEntries) archive.append(Buffer.from(entry.body), { name: entry.name });
    const uploaded = storage.putObject({
      key: packageKey,
      body: archive,
      contentType: 'application/zip',
      artifact: 'export',
    });
    await archive.finalize();
    await uploaded;
    const packageSize = archive.pointer();
    files.push({
      platformId: null,
      kind: 'package',
      key: packageKey,
      bytes: packageSize,
      durationMs: null,
      path: 'package.zip',
    });

    await db.transaction().execute(async (trx) => {
      await trx
        .updateTable('export_package')
        .set({
          status: 'succeeded',
          files: toJsonParam(files),
          manifest_key: manifestKey,
          checklist_key: checklistKey,
          package_key: packageKey,
          package_size: String(packageSize),
        })
        .where('id', '=', exportId)
        .execute();
      await trx
        .updateTable('render_job')
        .set({
          status: 'succeeded',
          stage: 'finalize',
          progress: 100,
          finished_at: nowLiteral(),
        })
        .where('id', '=', queueJob.jobId)
        .execute();
      const current = await trx
        .selectFrom('work')
        .select('step')
        .where('id', '=', jobRow.work_id)
        .executeTakeFirstOrThrow();
      const step = nextStep(current.step, 'export:succeeded');
      await trx
        .updateTable('work')
        .set({ step, phase: phaseOf(step), updated_at: nowLiteral() })
        .where('id', '=', jobRow.work_id)
        .execute();
    });
    await event(db, queueJob.jobId, 'done', {
      redirectTo: `/publish/${jobRow.work_id}/export`,
    });
    await analyticsEvent(db, {
      userId: queueJob.userId,
      workId: jobRow.work_id,
      event: 'export_completed',
      props: { exportId, packageKey, fileCount: files.length },
    });
    const completed = await completeJob(db, queueJob.jobId, owner, queueJob.leaseToken);
    if (!completed) throw new Error('QUEUE_FENCING_REJECTED');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await event(db, queueJob.jobId, 'error', { code: 'EXPORT_FAILED', message });
    const outcome = await failJob(db, queueJob.jobId, owner, queueJob.leaseToken, {
      code: 'EXPORT_FAILED',
      message,
    });
    if (outcome === 'dead') {
      const exportId = String(queueJob.payload['exportId'] ?? '');
      await db
        .updateTable('export_package')
        .set({ status: 'failed' })
        .where('id', '=', exportId)
        .execute();
      await db
        .updateTable('render_job')
        .set({ status: 'failed', stage: 'finalize', finished_at: nowLiteral() })
        .where('id', '=', queueJob.jobId)
        .execute();
    }
  } finally {
    clearInterval(timer);
  }
}

function layerScopeOf(scope: unknown): readonly string[] {
  return Array.isArray(scope) ? scope.filter((item): item is string => typeof item === 'string') : [];
}

async function settleWorkStep(
  trx: Kysely<Database>,
  workId: string,
  event: 'draft:succeeded' | 'hd:succeeded' | null,
): Promise<void> {
  const current = await trx
    .selectFrom('work')
    .select('step')
    .where('id', '=', workId)
    .executeTakeFirst();
  if (current === undefined) return;
  const step = event === null ? current.step : nextStep(current.step, event);
  await trx
    .updateTable('work')
    .set({ active_render_job_id: null, step, phase: phaseOf(step) })
    .where('id', '=', workId)
    .execute();
}

async function nextLayerVersion(
  db: Kysely<Database>,
  workId: string,
  kind: string,
): Promise<number> {
  const row = await db
    .selectFrom('asset_layer')
    .select('version')
    .where('work_id', '=', workId)
    .where('kind', '=', kind as never)
    .orderBy('version', 'desc')
    .executeTakeFirst();
  return (row?.version ?? 0) + 1;
}

export async function runOnce(db: Kysely<Database>): Promise<void> {
  await recoverExpiredLeases(db);
  await reconcileRenderJobs(db);

  const metricBucket = `${new Date().toISOString().slice(0, 13)}:00:00.000`.replace('T', ' ');
  if (scheduledMetricBucket !== metricBucket) {
    try {
      await db.transaction().execute((trx) =>
        enqueueInTransaction(trx, {
          queue: 'sys.metric',
          jobId: null,
          userId: null,
          payload: { bucket: metricBucket },
          dedupKey: `metric:${metricBucket}`,
        }),
      );
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== 'ER_DUP_ENTRY') throw error;
    }
    scheduledMetricBucket = metricBucket;
  }
  const metricJob = await claimJob(db, 'sys.metric', owner);
  if (metricJob !== null) {
    try {
      await computeMetricSnapshots(db);
    } catch (error) {
      console.error('[worker] metric snapshot failed', error instanceof Error ? error.message : error);
    }
    const completed = await completeClaimedJob(db, owner, metricJob);
    if (!completed) console.error('[worker] metric queue fencing rejected');
  }

  for (const queue of [
    'render.patch',
    'render.draft',
    'render.hd',
    'derive.media',
    'export.pack',
  ] as const) {
    const job = await claimJob(db, queue, owner);
    if (job === null) continue;
    if (job.jobId === null || job.userId === null) continue;
    const businessJob = job as BusinessClaimedJob;
    if (queue === 'derive.media') {
      await runDerivationClaim(db, businessJob);
      continue;
    }
    if (queue === 'export.pack') {
      await runExportClaim(db, businessJob);
      continue;
    }
    const timer = setInterval(
      () => void renewLease(db, businessJob.jobId, owner, businessJob.leaseToken),
      1_000,
    );
    try {
      if (await cancellationRequested(db, job.jobId)) {
        await finalizeCancellation(db, job.jobId, '用户取消渲染');
        await cancelClaimedJob(db, job.jobId, owner, job.leaseToken);
        return;
      }
      await event(db, job.jobId, 'status', { status: 'running' });
      const scripts = createScriptRepository(db);
      const jobRow = await db
        .selectFrom('render_job')
        .selectAll()
        .where('id', '=', job.jobId)
        .executeTakeFirstOrThrow();
      const markedRunning = await db
        .updateTable('render_job')
        .set({
          status: 'running',
          stage: 'slides',
          attempt: job.attempt + 1,
          started_at: jobRow.started_at ?? nowLiteral(),
        })
        .where('id', '=', job.jobId)
        .where('cancel_requested', '=', 0)
        .where('status', 'in', ['queued', 'running'])
        .executeTakeFirst();
      if (Number(markedRunning.numUpdatedRows) === 0) {
        await finalizeCancellation(db, job.jobId, '用户取消渲染');
        await cancelClaimedJob(db, job.jobId, owner, job.leaseToken);
        return;
      }
      const script = await scripts.forUser(job.userId).findLatest(jobRow.work_id);
      if (script === null) throw new Error('SCRIPT_NOT_FOUND');
      const videoAsset = jobRow.video_asset_id
        ? await db
            .selectFrom('video_asset')
            .selectAll()
            .where('id', '=', jobRow.video_asset_id)
            .executeTakeFirst()
        : undefined;
      const scriptContract = toContract(script);
      const timeline = timelineOf(scriptContract);
      const layerPlan = buildLayerPlan(scriptContract, {
        templateId: videoAsset?.template_id ?? 'tpl_ink_minimal',
        voiceId: videoAsset?.voice_id ?? 'voice_steady_male',
        speed: videoAsset === undefined ? 1 : Number(videoAsset.speed),
        orient: videoAsset?.orient ?? 'vertical',
      });
      const storage = createLocalStorage({
        endpoint: '',
        region: '',
        bucket: '',
        accessKeyId: '',
        secretAccessKey: '',
        root: process.env['LOCAL_STORAGE_ROOT'] ?? resolve(process.cwd(), '.local-storage'),
      });
      await event(db, job.jobId, 'progress', { stage: 'slides', progress: 10 });
      const layerIds: string[] = [];
      for (const layer of layerPlan) {
        if (jobRow.type === 'patch' && !layerScopeOf(jobRow.layer_scope).includes(layer.kind)) {
          continue;
        }
        const reusableLayer = await db
          .selectFrom('asset_layer')
          .select(['id', 'version'])
          .where('work_id', '=', jobRow.work_id)
          .where('kind', '=', layer.kind)
          .where('input_fingerprint', '=', layer.inputFingerprint)
          .executeTakeFirst();
        const layerVersion =
          reusableLayer?.version ?? (await nextLayerVersion(db, jobRow.work_id, layer.kind));
        const key = layerKey({
          userId: job.userId,
          workId: jobRow.work_id,
          kind: layer.kind,
          version: layerVersion,
        });
        await storage.putObject({
          key,
          body: layer.bytes,
          contentType: layer.contentType,
          artifact: 'layer',
        });
        const existingLayer = await db
          .selectFrom('asset_layer')
          .select('id')
          .where('work_id', '=', jobRow.work_id)
          .where('kind', '=', layer.kind)
          .where('input_fingerprint', '=', layer.inputFingerprint)
          .executeTakeFirst();
        if (existingLayer?.id != null) {
          layerIds.push(existingLayer.id);
          continue;
        }
        const layerId = `al_${randomUUID().replace(/-/g, '')}`;
        await db
          .insertInto('asset_layer')
          .values({
            id: layerId,
            work_id: jobRow.work_id,
            user_id: job.userId,
            kind: layer.kind,
            version: layerVersion,
            content_hash: layer.contentHash,
            storage_key: key,
            meta: toJsonParam(layer.meta),
            input_fingerprint: layer.inputFingerprint,
            duration_ms: layer.durationMs,
          })
          .execute();
        layerIds.push(layerId);
      }
      await event(db, job.jobId, 'progress', { stage: 'tts', progress: 20 });
      const audioFingerprint = fingerprint({
        scriptVersion: script.row.version,
        voiceId: videoAsset?.voice_id ?? 'voice_steady_male',
        speed: videoAsset === undefined ? 1 : Number(videoAsset.speed),
        kind: 'audio',
      });
      const existingAudio = await db
        .selectFrom('asset_layer')
        .select(['id', 'storage_key', 'version'])
        .where('work_id', '=', jobRow.work_id)
        .where('kind', '=', 'audio')
        .where('input_fingerprint', '=', audioFingerprint)
        .executeTakeFirst();
      const audioVersion =
        existingAudio?.version ?? (await nextLayerVersion(db, jobRow.work_id, 'audio'));
      const audioKey = layerKey({
        userId: job.userId,
        workId: jobRow.work_id,
        kind: 'audio',
        version: audioVersion,
      });
      let audio: Uint8Array;
      let audioLayerId: string;
      if (existingAudio?.id != null) {
        audioLayerId = existingAudio.id;
        const storedAudio = await storage.getObject(existingAudio.storage_key).catch(() => null);
        if (storedAudio !== null) {
          audio = storedAudio.body;
        } else {
          audio = await synthesizeAudio({
            text: timeline.map((line) => line.text).join('。'),
            voiceId: videoAsset?.voice_id ?? 'voice_steady_male',
            speed: videoAsset === undefined ? 1 : Number(videoAsset.speed),
          });
          await storage.putObject({
            key: audioKey,
            body: audio,
            contentType: 'audio/wav',
            artifact: 'layer',
          });
        }
      } else {
        audio = await synthesizeAudio({
          text: timeline.map((line) => line.text).join('。'),
          voiceId: videoAsset?.voice_id ?? 'voice_steady_male',
          speed: videoAsset === undefined ? 1 : Number(videoAsset.speed),
        });
        await storage.putObject({
          key: audioKey,
          body: audio,
          contentType: 'audio/wav',
          artifact: 'layer',
        });
        const audioLayerRowId = `al_${randomUUID().replace(/-/g, '')}`;
        const inserted = await db
          .insertInto('asset_layer')
          .values({
            id: audioLayerRowId,
            work_id: jobRow.work_id,
            user_id: job.userId,
            kind: 'audio',
            version: audioVersion,
            content_hash: fingerprint(
              Array.from(audio, (byte) => byte.toString(16).padStart(2, '0')).join(''),
            ),
            storage_key: audioKey,
            meta: toJsonParam({
              voiceId: videoAsset?.voice_id ?? 'voice_steady_male',
              speed: videoAsset === undefined ? 1 : Number(videoAsset.speed),
            }),
            input_fingerprint: audioFingerprint,
            duration_ms: timeline.at(-1)?.endMs ?? 0,
          })
          .execute();
        void inserted;
        audioLayerId = audioLayerRowId;
      }
      layerIds.push(audioLayerId);
      await event(db, job.jobId, 'progress', { stage: 'mux', progress: 75 });
      if (await cancellationRequested(db, job.jobId)) {
        await finalizeCancellation(db, job.jobId, '用户取消渲染');
        await cancelClaimedJob(db, job.jobId, owner, job.leaseToken);
        return;
      }
      const video = await renderVideo({
        audio,
        timeline,
        quality: videoAsset?.quality === 'hd' ? 'hd' : 'draft',
        orient: videoAsset?.orient ?? 'vertical',
      });
      const key = videoKey({
        userId: job.userId,
        workId: jobRow.work_id,
        variant: jobRow.type,
      });
      if (jobRow.video_asset_id == null) throw new Error('VIDEO_ASSET_ID_MISSING');
      const videoAssetId = jobRow.video_asset_id;
      await storage.putObject({
        key,
        body: video,
        contentType: 'video/mp4',
        artifact: jobRow.type === 'draft' ? 'draft' : 'video',
      });
      const outcome = await db.transaction().execute(async (trx) => {
        const lockedJob = await trx
          .selectFrom('render_job')
          .selectAll()
          .where('id', '=', jobRow.id)
          .forUpdate()
          .executeTakeFirstOrThrow();
        if (lockedJob.cancel_requested === 1) {
          if (lockedJob.reservation_id != null) {
            await releaseIfHeld(trx, lockedJob.reservation_id, '用户取消渲染');
          }
          await trx
            .updateTable('render_job')
            .set({ status: 'canceled', stage: 'finalize', finished_at: nowLiteral() })
            .where('id', '=', lockedJob.id)
            .execute();
          if (lockedJob.video_asset_id != null) {
            await trx
              .updateTable('video_asset')
              .set({ status: 'canceled' })
              .where('id', '=', lockedJob.video_asset_id)
              .execute();
          }
          await settleWorkStep(trx, lockedJob.work_id, null);
          return 'canceled' as const;
        }
        if (lockedJob.reservation_id != null)
          await commitQuotaInTransaction(trx, lockedJob.reservation_id);
        await trx
          .updateTable('video_asset')
          .set({ status: 'succeeded', storage_key: key, duration_ms: timeline.at(-1)?.endMs ?? 0 })
          .where('id', '=', jobRow.video_asset_id)
          .execute();
        await trx
          .updateTable('render_job')
          .set({
            status: 'succeeded',
            stage: 'finalize',
            progress: 100,
            finished_at: new Date().toISOString().replace('T', ' ').replace('Z', ''),
          })
          .where('id', '=', lockedJob.id)
          .execute();
        await settleWorkStep(
          trx,
          lockedJob.work_id,
          lockedJob.type === 'draft' ? 'draft:succeeded' : 'hd:succeeded',
        );
        if (audioLayerId == null) throw new Error('AUDIO_LAYER_ID_MISSING');
        for (const layerId of layerIds) {
          await trx
            .insertInto('video_asset_layer')
            .values({ video_asset_id: videoAssetId, layer_id: layerId })
            .onDuplicateKeyUpdate({ layer_id: layerId })
            .execute();
        }
        return 'succeeded' as const;
      });
      if (outcome === 'canceled') {
        await event(db, job.jobId, 'status', { status: 'canceled', reason: '用户取消渲染' });
        await cancelClaimedJob(db, job.jobId, owner, job.leaseToken);
        return;
      }
      await event(db, job.jobId, 'done', { redirectTo: `/studio/${jobRow.work_id}/video` });
      await analyticsEvent(db, {
        userId: job.userId,
        workId: jobRow.work_id,
        event: 'render_succeeded',
        props: { jobId: job.jobId, type: jobRow.type },
      });
      if (jobRow.type === 'patch') {
        await analyticsEvent(db, {
          userId: job.userId,
          workId: jobRow.work_id,
          event: 'video_patch_applied',
          props: { jobId: job.jobId, layerScope: layerScopeOf(jobRow.layer_scope) },
        });
      }
      const completed = await completeJob(db, job.jobId, owner, job.leaseToken);
      if (!completed) throw new Error('QUEUE_FENCING_REJECTED');
    } catch (error) {
      if (await cancellationRequested(db, job.jobId)) {
        await finalizeCancellation(db, job.jobId, '用户取消渲染');
        await cancelClaimedJob(db, job.jobId, owner, job.leaseToken);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[worker-job] ${job.jobId}: ${message}`);
      await event(db, job.jobId, 'error', { code: 'WORKER_FAILED', message });
      const outcome = await failJob(db, job.jobId, owner, job.leaseToken, {
        code: 'WORKER_FAILED',
        message,
      });
      if (outcome === 'dead') {
        const failedJob = await db
          .selectFrom('render_job')
          .select(['work_id', 'type'])
          .where('id', '=', businessJob.jobId)
          .executeTakeFirst();
        if (failedJob !== undefined) {
          await analyticsEvent(db, {
            userId: businessJob.userId,
            workId: failedJob.work_id,
            event: 'render_failed',
            props: { jobId: businessJob.jobId, type: failedJob.type, message },
          });
        }
        await releaseAfterFailure(db, businessJob.jobId, message);
      }
    } finally {
      clearInterval(timer);
    }
  }
}

async function main(): Promise<void> {
  const config = dbConfigFromEnv();
  const handle = createDb(config);
  const db = handle.db;
  const timer = setInterval(() => {
    void runOnce(db).catch((error: unknown) => {
      console.error('[worker]', error instanceof Error ? error.message : error);
    });
  }, 1_000);
  process.once('SIGINT', () => {
    clearInterval(timer);
    void handle.destroy().then(() => process.exit(0));
  });
  process.once('SIGTERM', () => {
    clearInterval(timer);
    void handle.destroy().then(() => process.exit(0));
  });
  console.error(`[worker] render queue started (${owner})`);
}

if (process.env['WORKER_STANDALONE'] !== 'false') void main();
