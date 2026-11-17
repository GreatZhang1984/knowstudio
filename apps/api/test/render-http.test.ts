import 'reflect-metadata';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DerivativeSchema,
  ExportAccepted,
  ExportPackageSchema,
  JobSchema,
  RenderAccepted,
} from '@knowstudio/contracts';
import { createScriptRepository } from '@knowstudio/db/repositories';
import { createDiscoverTestApp, type DiscoverTestApp } from './discover-harness.js';

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

async function readSseUntilDone(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return response.text();
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (value !== undefined) text += decoder.decode(value, { stream: true });
    if (done || text.includes('event: done')) break;
  }
  await reader.cancel().catch(() => undefined);
  return text;
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

async function cleanupRenderData(t: DiscoverTestApp): Promise<void> {
  await t.db
    .updateTable('work')
    .set({ active_render_job_id: null, step: 'video.draft', phase: 2 })
    .where('user_id', '=', t.seedUserId)
    .where('active_render_job_id', 'is not', null)
    .execute();
  await t.db
    .updateTable('render_job')
    .set({
      status: 'canceled',
      finished_at: new Date().toISOString().replace('T', ' ').replace('Z', ''),
    })
    .where('user_id', '=', t.seedUserId)
    .where('status', 'in', ['queued', 'running'])
    .execute();
  await t.db
    .deleteFrom('job_queue')
    .where('user_id', '=', t.seedUserId)
    .where('queue', 'in', ['render.draft', 'render.hd'])
    .execute();
  const held = await t.db
    .selectFrom('quota_reservation')
    .select('id')
    .where('user_id', '=', t.seedUserId)
    .where('state', '=', 'held')
    .execute();
  if (held.length > 0) {
    await t.db
      .deleteFrom('quota_ledger')
      .where(
        'reservation_id',
        'in',
        held.map((row) => row.id),
      )
      .execute();
    await t.db
      .deleteFrom('quota_reservation')
      .where(
        'id',
        'in',
        held.map((row) => row.id),
      )
      .execute();
  }
  await t.db
    .updateTable('quota_account')
    .set({ used: 22, reserved: 0 })
    .where('user_id', '=', t.seedUserId)
    .execute();
}

describe('T-35～T-48 E2E：分层渲染 / 配额 / 队列 / 视频产物', () => {
  let t: DiscoverTestApp;
  let workId: string;
  let storageRoot: string;
  let runWorker: (db: DiscoverTestApp['db']) => Promise<void>;

  beforeAll(async () => {
    process.env['WORKER_STANDALONE'] = 'false';
    storageRoot = resolve('apps', 'worker', '.local-storage');
    process.env['LOCAL_STORAGE_ROOT'] = storageRoot;
    const worker = await import('../../worker/src/main.js');
    runWorker = worker.runOnce;

    t = await createDiscoverTestApp();
    await cleanupRenderData(t);
    workId = `w_render_${Math.random().toString(36).slice(2, 12)}`;
    await t.db
      .insertInto('work')
      .values({
        id: workId,
        user_id: t.seedUserId,
        title: '渲染链路测试作品',
        keyword: '费曼学习法',
        step: 'topics',
        phase: 1,
        selected_topic_id: `${workId}_topic`,
      })
      .execute();
    await t.db
      .insertInto('topic_batch')
      .values({
        id: `${workId}_batch`,
        work_id: workId,
        user_id: t.seedUserId,
        batch_index: 1,
        based_on_material_ids: JSON.stringify([t.mat.k1]),
        hook_fingerprints: JSON.stringify([]),
        effective_count: 1,
      })
      .execute();
    await t.db
      .insertInto('topic')
      .values({
        id: `${workId}_topic`,
        batch_id: `${workId}_batch`,
        work_id: workId,
        hook: '渲染链路测试角度',
        angle: '渲染链路',
        blank_point: '真实视频闭环',
        basis_material_ids: JSON.stringify([t.mat.k1]),
        hook_fingerprint: 'b'.repeat(64),
        ord: 0,
      })
      .execute();
    for (const materialId of [t.mat.k1, t.mat.h1]) {
      await t.db
        .insertInto('work_material')
        .values({
          work_id: workId,
          material_id: materialId,
          user_id: t.seedUserId,
          used_in: JSON.stringify([]),
        })
        .execute();
    }
    const scripts = createScriptRepository(t.db).forUser(t.seedUserId);
    await scripts.create(
      workId,
      [
        { kind: 'hook3s', lines: [{ ord: 0, text: '三分钟讲透一个学习方法。' }] },
        {
          kind: 'body',
          lines: [
            { ord: 0, text: '先把概念讲给自己听，再补上卡住的细节。' },
            { ord: 1, text: '再把同一段内容讲给朋友听，听对方哪里皱眉。' },
            { ord: 2, text: '最后用一张白纸复述结构，确认每个步骤都能落地。' },
          ],
        },
        { kind: 'outro', lines: [{ ord: 0, text: '今晚就试一次，评论区告诉我结果。' }] },
      ],
      '三分钟讲透一个学习方法。',
    );
  }, 60_000);

  afterAll(async () => {
    if (t !== undefined) {
      const jobIds = await t.db
        .selectFrom('render_job')
        .select('id')
        .where('work_id', '=', workId)
        .execute();
      const reservationIds = await t.db
        .selectFrom('quota_reservation')
        .select('id')
        .where('work_id', '=', workId)
        .execute();
      if (jobIds.length > 0) {
        await t.db
          .deleteFrom('job_queue')
          .where(
            'job_id',
            'in',
            jobIds.map((job) => job.id),
          )
          .execute();
        await t.db
          .deleteFrom('render_job')
          .where(
            'id',
            'in',
            jobIds.map((job) => job.id),
          )
          .execute();
      }
      if (reservationIds.length > 0) {
        await t.db
          .deleteFrom('quota_ledger')
          .where(
            'reservation_id',
            'in',
            reservationIds.map((reservation) => reservation.id),
          )
          .execute();
      }
      await t.db.deleteFrom('quota_ledger').where('work_id', '=', workId).execute();
      await t.db.deleteFrom('quota_reservation').where('work_id', '=', workId).execute();
      await t.db
        .updateTable('quota_account')
        .set({ used: 22, reserved: 0 })
        .where('user_id', '=', t.seedUserId)
        .execute();
      await t.db.deleteFrom('derivative').where('work_id', '=', workId).execute();
      await t.db.deleteFrom('video_asset').where('work_id', '=', workId).execute();
      await t.db.deleteFrom('asset_layer').where('work_id', '=', workId).execute();
      await t.db.deleteFrom('work').where('id', '=', workId).execute();
      await t.cleanup();
    }
    await rm(storageRoot, { recursive: true, force: true });
  }, 60_000);

  it('未确认文案直调渲染 → 409 G2；确认后草稿 0 点入队并真实渲染 MP4', async () => {
    const metadataDenied = await fetch(`${t.baseUrl}/api/works/${workId}/derivatives:generate`, {
      method: 'POST',
      headers: auth(t.tokenA),
      body: JSON.stringify({ scope: 'metadata' }),
    });
    expect(metadataDenied.status).toBe(409);

    const denied = await fetch(`${t.baseUrl}/api/works/${workId}/video:draft`, {
      method: 'POST',
      headers: auth(t.tokenA),
      body: '{}',
    });
    expect(denied.status).toBe(409);

    const scripts = createScriptRepository(t.db).forUser(t.seedUserId);
    await scripts.confirm(workId);

    const acceptedRes = await fetch(`${t.baseUrl}/api/works/${workId}/video:draft`, {
      method: 'POST',
      headers: auth(t.tokenA),
      body: '{}',
    });
    expect(acceptedRes.status).toBe(202);
    const accepted = RenderAccepted.parse(await acceptedRes.json());
    expect(accepted.costPoints).toBe(0);
    expect(accepted.reservationId).toBeNull();

    const duplicate = await fetch(`${t.baseUrl}/api/works/${workId}/video:render`, {
      method: 'POST',
      headers: auth(t.tokenA),
      body: '{}',
    });
    expect(duplicate.status).toBe(409);

    await runWorker(t.db);
    const layers = await t.db
      .selectFrom('asset_layer')
      .select('kind')
      .where('work_id', '=', workId)
      .execute();
    expect(new Set(layers.map((layer) => layer.kind))).toEqual(
      new Set(['slides', 'subtitles', 'timeline', 'audio']),
    );
    const detail = await fetch(`${t.baseUrl}/api/jobs/${accepted.jobId}`, {
      headers: auth(t.tokenA),
    });
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as { job: unknown; videoUrl: string };
    expect(JobSchema.parse(body.job).status).toBe('succeeded');
    expect(body.videoUrl).toContain('/api/local-storage/');

    const videoRes = await fetch(`${t.baseUrl}${body.videoUrl}`);
    expect(videoRes.status).toBe(200);
    expect(videoRes.headers.get('content-type')).toBe('video/mp4');
    expect((await videoRes.arrayBuffer()).byteLength).toBeGreaterThan(1024);

    const eventsRes = await fetch(`${t.baseUrl}/api/jobs/${accepted.jobId}/events`, {
      headers: { ...auth(t.tokenA), 'Last-Event-ID': '3' },
    });
    expect(eventsRes.status).toBe(200);
    const eventText = await readSseUntilDone(eventsRes);
    expect(eventText).toContain('event: done');
    expect(eventText).not.toContain('event: progress');
  }, 120_000);

  it('metadata 派生只需 G2；缺省 scope 按 media 拦截 G3；单平台编辑互不影响', async () => {
    const mediaDenied = await fetch(`${t.baseUrl}/api/works/${workId}/derivatives:generate`, {
      method: 'POST',
      headers: auth(t.tokenA),
      body: '{}',
    });
    expect(mediaDenied.status).toBe(409);
    expect(await mediaDenied.json()).toMatchObject({
      code: 'GATE_NOT_SATISFIED',
      details: { requiredGate: 'G3' },
    });

    const accepted = await fetch(`${t.baseUrl}/api/works/${workId}/derivatives:generate`, {
      method: 'POST',
      headers: auth(t.tokenA),
      body: JSON.stringify({ scope: 'metadata' }),
    });
    expect(accepted.status).toBe(202);
    const generated = (await accepted.json()) as {
      derivatives: { platformId: string; title: string; tags: string[]; metadataReady: boolean }[];
      envelope: { step: string };
    };
    expect(generated.derivatives.map((item) => item.platformId).sort()).toEqual([
      'bili',
      'douyin',
      'sph',
      'xhs',
    ]);
    expect(generated.derivatives.every((item) => item.metadataReady)).toBe(true);
    expect(generated.envelope.step).toBe('derive');

    const bili = generated.derivatives.find((item) => item.platformId === 'bili');
    const douyin = generated.derivatives.find((item) => item.platformId === 'douyin');
    expect(bili).toBeDefined();
    expect(douyin).toBeDefined();
    const patched = await fetch(`${t.baseUrl}/api/works/${workId}/derivatives/bili`, {
      method: 'PATCH',
      headers: auth(t.tokenA),
      body: JSON.stringify({
        title: 'B站专属：把费曼学习法讲成一套复习流程',
        tags: ['费曼学习法', '复习流程', '深度讲解'],
      }),
    });
    expect(patched.status).toBe(200);
    const persisted = await fetch(`${t.baseUrl}/api/works/${workId}/derivatives`, {
      headers: auth(t.tokenA),
    });
    expect(persisted.status).toBe(200);
    const rows = ((await persisted.json()) as {
      derivatives: { platformId: string; title: string; tags: string[] }[];
    }).derivatives;
    expect(rows.find((row) => row.platformId === 'bili')?.title).toBe(
      'B站专属：把费曼学习法讲成一套复习流程',
    );
    expect(rows.find((row) => row.platformId === 'douyin')?.title).toBe(douyin?.title);

    const regenerated = await fetch(
      `${t.baseUrl}/api/works/${workId}/derivatives/xhs/title:regenerate`,
      { method: 'POST', headers: auth(t.tokenA) },
    );
    expect(regenerated.status).toBe(200);
    const title = ((await regenerated.json()) as { derivative: { title: string } }).derivative.title;
    expect(title).toContain('收藏版');
  }, 60_000);

  it('高清预扣 2 点；渲染成功后 used+2、reserved 回落、G3 生效', async () => {
    const before = await t.db
      .selectFrom('quota_account')
      .selectAll()
      .where('user_id', '=', t.seedUserId)
      .executeTakeFirstOrThrow();

    const acceptedRes = await fetch(`${t.baseUrl}/api/works/${workId}/video:render`, {
      method: 'POST',
      headers: auth(t.tokenA),
      body: '{}',
    });
    expect(acceptedRes.status).toBe(202);
    const accepted = RenderAccepted.parse(await acceptedRes.json());
    expect(accepted.costPoints).toBe(2);
    expect(accepted.reservationId).not.toBeNull();
    const held = await t.db
      .selectFrom('quota_account')
      .selectAll()
      .where('user_id', '=', t.seedUserId)
      .executeTakeFirstOrThrow();
    expect(held.reserved).toBe(before.reserved + 2);

    const cancelRes = await fetch(`${t.baseUrl}/api/jobs/${accepted.jobId}:cancel`, {
      method: 'POST',
      headers: auth(t.tokenA),
    });
    expect(cancelRes.status).toBe(200);
    expect(JobSchema.parse(await cancelRes.json()).status).toBe('canceled');
    const released = await t.db
      .selectFrom('quota_account')
      .selectAll()
      .where('user_id', '=', t.seedUserId)
      .executeTakeFirstOrThrow();
    expect(released.reserved).toBe(before.reserved);

    const retryRes = await fetch(`${t.baseUrl}/api/jobs/${accepted.jobId}:retry`, {
      method: 'POST',
      headers: auth(t.tokenA),
    });
    expect(retryRes.status).toBe(202);
    const retried = RenderAccepted.parse(await retryRes.json());
    expect(retried.reservationId).not.toBeNull();
    expect(retried.reservationId).not.toBe(accepted.reservationId);

    const parallelPatch = await fetch(`${t.baseUrl}/api/works/${workId}/derivatives/bili`, {
      method: 'PATCH',
      headers: auth(t.tokenA),
      body: JSON.stringify({ title: '渲染中修改的 B站标题' }),
    });
    expect(parallelPatch.status).toBe(200);

    await runWorker(t.db);
    const derivativeRows = await t.db
      .selectFrom('derivative')
      .select(['platform_id', 'title'])
      .where('work_id', '=', workId)
      .execute();
    expect(
      derivativeRows.find((row) => row.platform_id === 'bili')?.title,
    ).toBe('渲染中修改的 B站标题');
    const audioLayers = await t.db
      .selectFrom('asset_layer')
      .select('id')
      .where('work_id', '=', workId)
      .where('kind', '=', 'audio')
      .execute();
    expect(audioLayers).toHaveLength(1);
    const after = await t.db
      .selectFrom('quota_account')
      .selectAll()
      .where('user_id', '=', t.seedUserId)
      .executeTakeFirstOrThrow();
    expect(after.used).toBe(before.used + 2);
    expect(after.reserved).toBe(before.reserved);

    const detailRes = await fetch(`${t.baseUrl}/api/works/${workId}`, { headers: auth(t.tokenA) });
    const envelope = (await detailRes.json()) as { gates: { G3: boolean }; step: string };
    expect(envelope.gates.G3).toBe(true);
    expect(envelope.step).toBe('derive');

    const patchPreviewRes = await fetch(`${t.baseUrl}/api/works/${workId}/video`, {
      method: 'PATCH',
      headers: auth(t.tokenA),
      body: JSON.stringify({ templateId: 'tpl_violet_knowledge' }),
    });
    expect(patchPreviewRes.status).toBe(200);
    expect(await patchPreviewRes.json()).toEqual({
      invalidatedLayers: ['slides'],
      incrementalPoints: 1,
      requiresConfirm: true,
    });

    const patchRes = await fetch(`${t.baseUrl}/api/works/${workId}/video:patch`, {
      method: 'POST',
      headers: auth(t.tokenA),
      body: JSON.stringify({ layerScope: ['slides'] }),
    });
    expect(patchRes.status).toBe(202);
    const patch = RenderAccepted.parse(await patchRes.json());
    expect(patch.costPoints).toBe(1);
    expect(patch.reservationId).not.toBeNull();
    await runWorker(t.db);
    const patchJob = await t.db
      .selectFrom('render_job')
      .select(['status', 'type'])
      .where('id', '=', patch.jobId)
      .executeTakeFirstOrThrow();
    expect(patchJob).toEqual({ status: 'succeeded', type: 'patch' });

    const patched = await t.db
      .selectFrom('quota_account')
      .selectAll()
      .where('user_id', '=', t.seedUserId)
      .executeTakeFirstOrThrow();
    expect(patched.used).toBe(before.used + 3);
    expect(patched.reserved).toBe(before.reserved);
  }, 120_000);

  it('G3 后媒体派生生成四平台 MP4/封面，精华版按真实时长裁剪', async () => {
    const acceptedRes = await fetch(`${t.baseUrl}/api/works/${workId}/derivatives:generate`, {
      method: 'POST',
      headers: auth(t.tokenA),
      body: JSON.stringify({ scope: 'media' }),
    });
    expect(acceptedRes.status).toBe(202);
    const accepted = RenderAccepted.parse(await acceptedRes.json());
    expect(accepted.costPoints).toBe(0);
    expect(accepted.reservationId).toBeNull();

    await runWorker(t.db);
    const jobRes = await fetch(`${t.baseUrl}/api/jobs/${accepted.jobId}`, { headers: auth(t.tokenA) });
    expect(jobRes.status).toBe(200);
    expect(JobSchema.parse(((await jobRes.json()) as { job: unknown }).job).status).toBe('succeeded');

    const listRes = await fetch(`${t.baseUrl}/api/works/${workId}/derivatives`, {
      headers: auth(t.tokenA),
    });
    expect(listRes.status).toBe(200);
    const rows = DerivativeSchema.array().parse(
      ((await listRes.json()) as { derivatives: unknown }).derivatives,
    );
    expect(rows.every((row) => row.mediaReady && row.videoAssetId !== null)).toBe(true);
    expect(rows.every((row) => row.coverLayerId !== null)).toBe(true);
    expect(rows.every((row) => row.mediaUrl?.includes('/api/local-storage/') ?? false)).toBe(true);

    const videoAssets = await t.db
      .selectFrom('video_asset')
      .selectAll()
      .where(
        'id',
        'in',
        rows.map((row) => row.videoAssetId as string),
      )
      .execute();
    const bili = videoAssets.find((asset) => asset.orient === 'horizontal');
    const xhs = rows.find((row) => row.platformId === 'xhs');
    const xhsAsset = videoAssets.find((asset) => asset.id === xhs?.videoAssetId);
    expect(bili).toBeDefined();
    expect(xhsAsset?.duration_ms ?? 0).toBeLessThanOrEqual(15_000);
    expect(bili?.duration_ms ?? 0).toBeGreaterThan(xhsAsset?.duration_ms ?? 0);
  }, 120_000);

  it('T-56：合规复核后导出四平台 ZIP，过期读取只重签不重打包', async () => {
    const blocked = await fetch(`${t.baseUrl}/api/works/${workId}/export`, {
      method: 'POST',
      headers: auth(t.tokenA),
    });
    expect(blocked.status).toBe(422);
    expect(await blocked.json()).toMatchObject({
      code: 'COMPLIANCE_BLOCKED',
      details: { blockingItems: [{ kind: 'content', blocking: true }] },
    });
    expect(
      await t.db
        .selectFrom('export_package')
        .select('id')
        .where('work_id', '=', workId)
        .execute(),
    ).toEqual([]);

    const removed = await fetch(`${t.baseUrl}/api/works/${workId}/materials/${t.mat.h1}`, {
      method: 'DELETE',
      headers: auth(t.tokenA),
    });
    expect(removed.status).toBe(200);

    const acceptedRes = await fetch(`${t.baseUrl}/api/works/${workId}/export`, {
      method: 'POST',
      headers: auth(t.tokenA),
    });
    expect(acceptedRes.status).toBe(202);
    const accepted = ExportAccepted.parse(await acceptedRes.json());
    await runWorker(t.db);

    const exportJob = await t.db
      .selectFrom('render_job')
      .select(['status', 'type'])
      .where('id', '=',
        (
          await t.db
            .selectFrom('render_job')
            .select('id')
            .where('work_id', '=', workId)
            .where('type', '=', 'export')
            .executeTakeFirstOrThrow()
        ).id,
      )
      .executeTakeFirst();
    expect(exportJob).toEqual({ status: 'succeeded', type: 'export' });

    const detailRes = await fetch(`${t.baseUrl}/api/exports/${accepted.exportId}`, {
      headers: auth(t.tokenA),
    });
    expect(detailRes.status).toBe(200);
    const detail = ExportPackageSchema.parse(await detailRes.json());
    expect(detail.status).toBe('succeeded');
    expect(detail.files).toHaveLength(11);
    expect(detail.files.filter((file) => file.kind === 'video')).toHaveLength(4);
    expect(detail.files.filter((file) => file.kind === 'cover')).toHaveLength(4);

    const packageFile = detail.files.find((file) => file.kind === 'package');
    expect(packageFile).toBeDefined();
    const packageRes = await fetch(`${t.baseUrl}${packageFile?.url}`);
    expect(packageRes.status).toBe(200);
    expect(packageRes.headers.get('content-type')).toBe('application/octet-stream');
    const zip = Buffer.from(new Uint8Array(await packageRes.arrayBuffer()));
    expect(zip.byteLength).toBeGreaterThan(1024);
    const entries = readStoredZip(zip);
    expect([...entries.keys()].sort()).toEqual(
      [
        'bili/cover.svg',
        'bili/video.mp4',
        'douyin/cover.svg',
        'douyin/video.mp4',
        'manifest.json',
        'sph/cover.svg',
        'sph/video.mp4',
        'xhs/cover.svg',
        'xhs/video.mp4',
        '发布清单.md',
      ].sort(),
    );
    for (const name of entries.keys()) {
      if (name.endsWith('.mp4') || name.endsWith('.svg')) {
        expect(entries.get(name)?.byteLength, name).toBeGreaterThan(0);
      }
    }
    const manifest = JSON.parse(entries.get('manifest.json')?.toString('utf8') ?? '{}') as {
      exportId: string;
      platforms: { platformId: string }[];
    };
    expect(manifest.exportId).toBe(accepted.exportId);
    expect(manifest.platforms.map((item) => item.platformId).sort()).toEqual([
      'bili',
      'douyin',
      'sph',
      'xhs',
    ]);
    expect(entries.get('发布清单.md')?.toString('utf8')).toContain(
      '需你本人登录各平台手动发布',
    );

    const before = await t.db
      .selectFrom('export_package')
      .select(['package_key', 'package_size'])
      .where('id', '=', accepted.exportId)
      .executeTakeFirstOrThrow();
    await t.db
      .updateTable('export_package')
      .set({ expires_at: '2000-01-01 00:00:00.000' })
      .where('id', '=', accepted.exportId)
      .execute();
    const refreshedRes = await fetch(`${t.baseUrl}/api/exports/${accepted.exportId}`, {
      headers: auth(t.tokenA),
    });
    expect(refreshedRes.status).toBe(200);
    const refreshed = ExportPackageSchema.parse(await refreshedRes.json());
    expect(Date.parse(refreshed.expiresAt)).toBeGreaterThan(Date.now() - 1_000);
    const after = await t.db
      .selectFrom('export_package')
      .select(['package_key', 'package_size'])
      .where('id', '=', accepted.exportId)
      .executeTakeFirstOrThrow();
    expect(after).toEqual(before);
    expect(
      await t.db
        .selectFrom('export_package')
        .select('id')
        .where('work_id', '=', workId)
        .execute(),
    ).toHaveLength(1);
  }, 120_000);
});
