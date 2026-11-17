import 'reflect-metadata';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ComplianceReportSchema,
  DerivativeSchema,
  ExportAccepted,
  ExportPackageSchema,
  RenderAccepted,
  ScriptSchema,
  SearchAccepted,
  SearchSessionSchema,
  TopicBatchSchema,
  WorkEnvelopeSchema,
  type Script,
  type SearchSession,
} from '@knowstudio/contracts';
import { computeMetricSnapshots } from '@knowstudio/observability';
import { createDiscoverTestApp, type DiscoverTestApp } from './discover-harness.js';

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function pollSearch(t: DiscoverTestApp, id: string): Promise<SearchSession> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const response = await fetch(`${t.baseUrl}/api/discover/search/${id}`, {
      headers: auth(t.tokenA),
    });
    expect(response.status).toBe(200);
    const session = SearchSessionSchema.parse(await response.json());
    if (['succeeded', 'failed', 'canceled'].includes(session.status)) return session;
    await delay(20);
  }
  throw new Error(`搜索会话 ${id} 轮询 5 秒未到终态`);
}

function patchBody(script: Script): unknown {
  return {
    baseVersion: script.version,
    sections: script.sections.map((section, sectionIndex) => ({
      kind: section.kind,
      lines: section.lines.map((line, lineIndex) => ({
        id: line.id,
        ord: line.ord,
        text: sectionIndex === 0 && lineIndex === 0 ? `${line.text}（验收润色）` : line.text,
      })),
    })),
  };
}

function readStoredZip(zip: Buffer): Map<string, Buffer> {
  let eocd = -1;
  for (let offset = zip.length - 22; offset >= 0; offset -= 1) {
    if (zip.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error('ZIP_EOCD_MISSING');

  const count = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);
  const entries = new Map<string, Buffer>();
  for (let index = 0; index < count; index += 1) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) throw new Error('ZIP_CENTRAL_HEADER_INVALID');
    if (zip.readUInt16LE(offset + 10) !== 0) throw new Error('ZIP_ENTRY_COMPRESSED');
    const size = zip.readUInt32LE(offset + 24);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localOffset = zip.readUInt32LE(offset + 42);
    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    const dataOffset =
      localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28);
    entries.set(name, zip.subarray(dataOffset, dataOffset + size));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

describe('T-61 真实作品全链路验收', () => {
  let t: DiscoverTestApp;
  let workId: string;
  let storageRoot: string;
  let runWorker: (db: DiscoverTestApp['db']) => Promise<void>;
  let quotaBefore: { used: number; reserved: number };
  let metricBucket: string;
  let licensedCloneId: string | undefined;
  let previousSnapshots: Awaited<ReturnType<DiscoverTestApp['db']['selectFrom']>> extends never
    ? never
    : Array<{
        metric: string;
        scope: string;
        scope_id: string;
        bucket: string;
        value_num: string;
        sample_n: number;
        computed_at: string;
      }>;

  beforeAll(async () => {
    process.env['WORKER_STANDALONE'] = 'false';
    storageRoot = resolve('apps', 'worker', '.local-storage-acceptance');
    process.env['LOCAL_STORAGE_ROOT'] = storageRoot;
    const worker = await import('../../worker/src/main.js');
    runWorker = worker.runOnce;

    t = await createDiscoverTestApp();
    const quota = await t.db
      .selectFrom('quota_account')
      .select(['used', 'reserved'])
      .where('user_id', '=', t.seedUserId)
      .executeTakeFirstOrThrow();
    quotaBefore = quota;
    metricBucket = `${new Date().toISOString().slice(0, 13)}:00:00.000`.replace('T', ' ');
    previousSnapshots = (await t.db
      .selectFrom('metric_snapshot')
      .selectAll()
      .where('bucket', '=', metricBucket)
      .execute()) as typeof previousSnapshots;
  }, 60_000);

  afterAll(async () => {
    if (t !== undefined) {
      if (workId !== undefined) {
        const jobs = await t.db
          .selectFrom('render_job')
          .select('id')
          .where('work_id', '=', workId)
          .execute();
        if (jobs.length > 0) {
          await t.db
            .deleteFrom('job_queue')
            .where(
              'job_id',
              'in',
              jobs.map((job) => job.id),
            )
            .execute();
        }
        await t.db.deleteFrom('export_package').where('work_id', '=', workId).execute();
        await t.db.deleteFrom('derivative').where('work_id', '=', workId).execute();
        await t.db.deleteFrom('render_job').where('work_id', '=', workId).execute();
        await t.db.deleteFrom('video_asset').where('work_id', '=', workId).execute();
        await t.db.deleteFrom('asset_layer').where('work_id', '=', workId).execute();
        await t.db
          .deleteFrom('quota_ledger')
          .where((expression) =>
            expression.or([
              expression.eb('work_id', '=', workId),
              expression.eb(
                'reservation_id',
                'in',
                t.db.selectFrom('quota_reservation').select('id').where('work_id', '=', workId),
              ),
            ]),
          )
          .execute();
        await t.db.deleteFrom('quota_reservation').where('work_id', '=', workId).execute();
        await t.db
          .updateTable('quota_account')
          .set({ used: quotaBefore.used, reserved: quotaBefore.reserved })
          .where('user_id', '=', t.seedUserId)
          .execute();
        await t.db.deleteFrom('analytics_event').where('work_id', '=', workId).execute();
        await t.db.deleteFrom('ai_call_log').where('work_id', '=', workId).execute();
        await t.db.deleteFrom('audit_log').where('work_id', '=', workId).execute();
        await t.db.deleteFrom('work').where('id', '=', workId).execute();
      }
      if (licensedCloneId !== undefined) {
        await t.db.deleteFrom('material').where('id', '=', licensedCloneId).execute();
      }
      await t.db.deleteFrom('metric_snapshot').where('bucket', '=', metricBucket).execute();
      if (previousSnapshots.length > 0) {
        await t.db
          .insertInto('metric_snapshot')
          .values(previousSnapshots as never)
          .execute();
      }
      await t.cleanup();
    }
    await rm(storageRoot, { recursive: true, force: true });
  }, 60_000);

  it('从新建作品到导出、发布回执与指标快照全链路真实闭环', async () => {
    const createdRes = await fetch(`${t.baseUrl}/api/works`, {
      method: 'POST',
      headers: auth(t.tokenA),
      body: JSON.stringify({ keyword: '费曼学习法', title: 'T-61 真实全链路验收' }),
    });
    expect(createdRes.status).toBe(201);
    const envelope = WorkEnvelopeSchema.parse(await createdRes.json());
    workId = envelope.id;
    expect(envelope.step).toBe('search');
    expect(envelope.gates).toMatchObject({ G1: false, G2: false, G3: false, G4: false });

    const searchRes = await fetch(`${t.baseUrl}/api/discover/search`, {
      method: 'POST',
      headers: auth(t.tokenA),
      body: JSON.stringify({ workId, keyword: '费曼学习法', force: true }),
    });
    expect(searchRes.status).toBe(202);
    const accepted = SearchAccepted.parse(await searchRes.json());
    const session = await pollSearch(t, accepted.searchId);
    expect(session.status).toBe('succeeded');
    expect(session.materials).toHaveLength(10);
    expect(session.saturation?.sampleSize).toBe(10);
    expect(session.blankAngles.length).toBeGreaterThan(0);

    const basis = [t.mat.k1, t.mat.p2];
    for (const materialId of basis) {
      const collectRes = await fetch(`${t.baseUrl}/api/works/${workId}/materials`, {
        method: 'POST',
        headers: auth(t.tokenA),
        body: JSON.stringify({ materialId }),
      });
      expect(collectRes.status).toBe(200);
      expect(((await collectRes.json()) as { collectedCount: number }).collectedCount).toBe(
        basis.indexOf(materialId) + 1,
      );
    }

    const topicsRes = await fetch(`${t.baseUrl}/api/works/${workId}/topics:generate`, {
      method: 'POST',
      headers: auth(t.tokenA),
      body: JSON.stringify({ materialIds: basis }),
    });
    expect(topicsRes.status).toBe(202);
    const topicListRes = await fetch(`${t.baseUrl}/api/works/${workId}/topics`, {
      headers: auth(t.tokenA),
    });
    expect(topicListRes.status).toBe(200);
    const batch = TopicBatchSchema.parse(await topicListRes.json());
    expect(batch.workId).toBe(workId);
    expect(batch.topics).toHaveLength(12);
    const selectedTopic = batch.topics[0]!;

    const selectRes = await fetch(`${t.baseUrl}/api/works/${workId}/topic:select`, {
      method: 'POST',
      headers: auth(t.tokenA),
      body: JSON.stringify({ topicId: selectedTopic.id }),
    });
    expect(selectRes.status).toBe(200);
    const selected = WorkEnvelopeSchema.parse(await selectRes.json());
    expect(selected.selectedTopicId).toBe(selectedTopic.id);
    expect(selected.gates.G1).toBe(true);
    expect(selected.step).toBe('script');

    const scriptGenerateRes = await fetch(`${t.baseUrl}/api/works/${workId}/script:generate`, {
      method: 'POST',
      headers: auth(t.tokenA),
      body: '{}',
    });
    expect(scriptGenerateRes.status).toBe(202);
    const scriptRes = await fetch(`${t.baseUrl}/api/works/${workId}/script`, {
      headers: auth(t.tokenA),
    });
    expect(scriptRes.status).toBe(200);
    const script = ScriptSchema.parse(await scriptRes.json());
    expect(script.status).toBe('draft');
    expect(script.sections.map((section) => section.kind)).toEqual(['hook3s', 'body', 'outro']);

    const patchRes = await fetch(`${t.baseUrl}/api/works/${workId}/script`, {
      method: 'PATCH',
      headers: auth(t.tokenA),
      body: JSON.stringify(patchBody(script)),
    });
    expect(patchRes.status).toBe(200);
    const patched = ((await patchRes.json()) as { script: Script }).script;
    expect(patched.version).toBe(script.version + 1);
    expect(patched.sections[0]?.lines[0]?.text).toContain('（验收润色）');

    const firstEditEvent = await fetch(`${t.baseUrl}/api/events`, {
      method: 'POST',
      headers: auth(t.tokenA),
      body: JSON.stringify({
        events: [
          {
            event: 'script_first_edit',
            workId,
            props: { editDistanceRatio: 0.05 },
            occurredAt: new Date().toISOString(),
          },
        ],
      }),
    });
    const firstEditBody = (await firstEditEvent.json()) as { accepted?: number };
    expect(firstEditEvent.status).toBe(200);
    expect(firstEditBody).toEqual({ accepted: 1 });

    const confirmRes = await fetch(`${t.baseUrl}/api/works/${workId}/script:confirm`, {
      method: 'POST',
      headers: auth(t.tokenA),
    });
    expect(confirmRes.status).toBe(200);
    const confirmed = ((await confirmRes.json()) as { envelope: { gates: { G2: boolean } } })
      .envelope;
    expect(confirmed.gates.G2).toBe(true);

    const draftRes = await fetch(`${t.baseUrl}/api/works/${workId}/video:draft`, {
      method: 'POST',
      headers: auth(t.tokenA),
      body: '{}',
    });
    expect(draftRes.status).toBe(202);
    const draft = RenderAccepted.parse(await draftRes.json());
    expect(draft.costPoints).toBe(0);
    await runWorker(t.db);
    const draftDetailRes = await fetch(`${t.baseUrl}/api/jobs/${draft.jobId}`, {
      headers: auth(t.tokenA),
    });
    expect(draftDetailRes.status).toBe(200);
    const draftDetail = (await draftDetailRes.json()) as { videoUrl: string };
    const draftVideoRes = await fetch(`${t.baseUrl}${draftDetail.videoUrl}`);
    expect(draftVideoRes.status).toBe(200);
    expect((await draftVideoRes.arrayBuffer()).byteLength).toBeGreaterThan(1024);

    const draftPreviewRes = await fetch(`${t.baseUrl}/api/works/${workId}/video`, {
      method: 'PATCH',
      headers: auth(t.tokenA),
      body: '{}',
    });
    expect(draftPreviewRes.status).toBe(200);
    expect(await draftPreviewRes.json()).toEqual({
      invalidatedLayers: [],
      incrementalPoints: 0,
      requiresConfirm: false,
    });

    const metadataRes = await fetch(`${t.baseUrl}/api/works/${workId}/derivatives:generate`, {
      method: 'POST',
      headers: auth(t.tokenA),
      body: JSON.stringify({ scope: 'metadata' }),
    });
    expect(metadataRes.status).toBe(202);
    const derivativeListRes = await fetch(`${t.baseUrl}/api/works/${workId}/derivatives`, {
      headers: auth(t.tokenA),
    });
    expect(derivativeListRes.status).toBe(200);
    const derivatives = DerivativeSchema.array().parse(
      ((await derivativeListRes.json()) as { derivatives: unknown }).derivatives,
    );
    expect(derivatives.map((item) => item.platformId).sort()).toEqual([
      'bili',
      'douyin',
      'sph',
      'xhs',
    ]);
    expect(derivatives.every((item) => item.metadataReady)).toBe(true);

    const hdRes = await fetch(`${t.baseUrl}/api/works/${workId}/video:render`, {
      method: 'POST',
      headers: auth(t.tokenA),
      body: '{}',
    });
    expect(hdRes.status).toBe(202);
    const hd = RenderAccepted.parse(await hdRes.json());
    expect(hd.costPoints).toBe(2);
    await runWorker(t.db);
    const hdDetailRes = await fetch(`${t.baseUrl}/api/jobs/${hd.jobId}`, {
      headers: auth(t.tokenA),
    });
    expect(hdDetailRes.status).toBe(200);
    const hdEnvelope = WorkEnvelopeSchema.parse(
      await (await fetch(`${t.baseUrl}/api/works/${workId}`, { headers: auth(t.tokenA) })).json(),
    );
    expect(hdEnvelope.gates.G3).toBe(true);

    const mediaRes = await fetch(`${t.baseUrl}/api/works/${workId}/derivatives:generate`, {
      method: 'POST',
      headers: auth(t.tokenA),
      body: JSON.stringify({ scope: 'media' }),
    });
    expect(mediaRes.status).toBe(202);
    const mediaJob = RenderAccepted.parse(await mediaRes.json());
    await runWorker(t.db);
    const mediaDetailRes = await fetch(`${t.baseUrl}/api/jobs/${mediaJob.jobId}`, {
      headers: auth(t.tokenA),
    });
    expect(mediaDetailRes.status).toBe(200);
    const platformMedia = DerivativeSchema.array().parse(
      (
        (await (
          await fetch(`${t.baseUrl}/api/works/${workId}/derivatives`, { headers: auth(t.tokenA) })
        ).json()) as { derivatives: unknown }
      ).derivatives,
    );
    expect(platformMedia.every((item) => item.mediaReady && item.videoAssetId)).toBe(true);
    expect(platformMedia.every((item) => item.mediaUrl?.includes('/api/local-storage/'))).toBe(
      true,
    );

    const blockedComplianceRes = await fetch(`${t.baseUrl}/api/works/${workId}/compliance`, {
      headers: auth(t.tokenA),
    });
    expect(blockedComplianceRes.status).toBe(200);
    expect(
      ComplianceReportSchema.parse(await blockedComplianceRes.json()).blockingCount,
    ).toBeGreaterThan(0);
    const blockedEnvelope = WorkEnvelopeSchema.parse(
      await (await fetch(`${t.baseUrl}/api/works/${workId}`, { headers: auth(t.tokenA) })).json(),
    );
    expect(blockedEnvelope.gates.G4).toBe(false);

    const licenseRes = await fetch(
      `${t.baseUrl}/api/works/${workId}/materials/${t.mat.p2}/license`,
      {
        method: 'POST',
        headers: auth(t.tokenA),
        body: JSON.stringify({
          evidenceType: 'commercial_use_grant',
          evidenceUrl: 'https://example.invalid/full-license.pdf',
        }),
      },
    );
    expect(licenseRes.status).toBe(200);
    const licensed = (await licenseRes.json()) as {
      materialId: string;
      envelope: { gates: { G4: boolean } };
    };
    licensedCloneId = licensed.materialId;
    expect(licensedCloneId).not.toBe(t.mat.p2);
    expect(licensed.envelope.gates.G4).toBe(true);

    const exportRes = await fetch(`${t.baseUrl}/api/works/${workId}/export`, {
      method: 'POST',
      headers: auth(t.tokenA),
    });
    expect(exportRes.status).toBe(202);
    const exportAccepted = ExportAccepted.parse(await exportRes.json());
    await runWorker(t.db);
    const exportDetailRes = await fetch(`${t.baseUrl}/api/exports/${exportAccepted.exportId}`, {
      headers: auth(t.tokenA),
    });
    expect(exportDetailRes.status).toBe(200);
    const exportDetail = ExportPackageSchema.parse(await exportDetailRes.json());
    expect(exportDetail.status).toBe('succeeded');
    expect(exportDetail.files).toHaveLength(11);
    const packageFile = exportDetail.files.find((file) => file.kind === 'package');
    expect(packageFile).toBeDefined();
    const packageRes = await fetch(`${t.baseUrl}${packageFile?.url}`);
    expect(packageRes.status).toBe(200);
    const zip = Buffer.from(new Uint8Array(await packageRes.arrayBuffer()));
    expect(zip.byteLength).toBeGreaterThan(1024);
    const entries = readStoredZip(zip);
    expect(entries.get('manifest.json')?.byteLength ?? 0).toBeGreaterThan(0);
    expect(entries.get('发布清单.md')?.toString('utf8')).toContain('需你本人登录各平台手动发布');

    const publishReceiptRes = await fetch(`${t.baseUrl}/api/events`, {
      method: 'POST',
      headers: auth(t.tokenA),
      body: JSON.stringify({
        events: [
          {
            event: 'publish_receipt_marked',
            workId,
            props: { platformId: 'douyin' },
            occurredAt: new Date().toISOString(),
          },
        ],
      }),
    });
    expect(publishReceiptRes.status).toBe(200);
    expect(await publishReceiptRes.json()).toEqual({ accepted: 1 });

    await computeMetricSnapshots(t.db, metricBucket);
    const metricsRes = await fetch(`${t.baseUrl}/api/metrics`, { headers: auth(t.tokenA) });
    expect(metricsRes.status).toBe(200);
    const metrics = (await metricsRes.json()) as {
      fresh: boolean;
      items: { metric: string; sampleN: number }[];
      g4BlindTest: { source: 'manual'; value: number | null };
    };
    expect(metrics.fresh).toBe(true);
    expect(metrics.items).toHaveLength(11);
    expect(metrics.g4BlindTest).toEqual({ source: 'manual', value: null });

    const events = await t.db
      .selectFrom('analytics_event')
      .select('event')
      .where('work_id', '=', workId)
      .execute();
    const names = new Set(events.map((event) => event.event));
    for (const name of [
      'work_created',
      'search_completed',
      'material_collected',
      'topic_batch_generated',
      'topic_selected',
      'script_generated',
      'script_first_edit',
      'script_confirmed',
      'draft_previewed',
      'render_started',
      'render_succeeded',
      'derivative_generated',
      'export_completed',
      'publish_receipt_marked',
    ]) {
      expect(names.has(name), name).toBe(true);
    }

    const quotaAfter = await t.db
      .selectFrom('quota_account')
      .select(['used', 'reserved'])
      .where('user_id', '=', t.seedUserId)
      .executeTakeFirstOrThrow();
    expect(quotaAfter.used).toBe(quotaBefore.used + 2);
    expect(quotaAfter.reserved).toBe(quotaBefore.reserved);
  }, 300_000);
});
