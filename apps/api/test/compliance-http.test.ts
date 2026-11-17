import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CollectMaterialResponse,
  ComplianceReportSchema,
  WorkEnvelopeSchema,
  type ComplianceReport,
  type WorkEnvelope,
} from '@knowstudio/contracts';
import { toJsonParam } from '@knowstudio/db';
import { createScriptRepository } from '@knowstudio/db/repositories';
import { createDiscoverTestApp, type DiscoverTestApp } from './discover-harness.js';

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

async function getJson<T>(url: string, token: string): Promise<T> {
  const response = await fetch(url, { headers: auth(token) });
  expect(response.status).toBe(200);
  return (await response.json()) as T;
}

async function envelopeOf(t: DiscoverTestApp, workId: string): Promise<WorkEnvelope> {
  return WorkEnvelopeSchema.parse(await getJson(`${t.baseUrl}/api/works/${workId}`, t.tokenA));
}

describe('T-54/T-55 E2E：合规检查、凭证修复、复检与 G4 防陈旧', () => {
  let t: DiscoverTestApp;
  let workId: string;
  let cloneMaterialId: string | undefined;
  const cloneMaterialIds: string[] = [];

  beforeAll(async () => {
    t = await createDiscoverTestApp();
    workId = `w_compliance_${Math.random().toString(36).slice(2, 12)}`;
    await t.db
      .insertInto('work')
      .values({
        id: workId,
        user_id: t.seedUserId,
        title: '合规闭环测试作品',
        keyword: '合规闭环',
        step: 'derive',
        phase: 3,
      })
      .execute();
    await t.db
      .insertInto('work_material')
      .values({
        work_id: workId,
        material_id: t.mat.p2,
        user_id: t.seedUserId,
        used_in: toJsonParam([{ target: 'slides', pageId: 'p1' }]),
      })
      .execute();
    await t.db
      .insertInto('derivative')
      .values({
        id: `${workId}_dv`,
        work_id: workId,
        user_id: t.seedUserId,
        platform_id: 'douyin',
        rule_version: 1,
        title: '合规测试标题',
        tags: toJsonParam(['合规测试']),
      })
      .execute();
    const scripts = createScriptRepository(t.db).forUser(t.seedUserId);
    const script = await scripts.create(
      workId,
      [{ kind: 'hook3s', lines: [{ ord: 0, text: '三分钟讲清一个合规细节。' }] }],
      '三分钟讲清一个合规细节。',
    );
    await scripts.confirm(workId);
    await t.db
      .insertInto('video_asset')
      .values({
        id: `${workId}_va`,
        work_id: workId,
        user_id: t.seedUserId,
        quality: 'hd',
        status: 'succeeded',
        storage_key: 'layers/test.mp4',
        duration_ms: 3000,
        resolution: '1080x1920',
        orient: 'vertical',
        template_id: 'tpl_ink_minimal',
        voice_id: 'voice_steady_male',
        speed: '1.000',
        script_version: script.row.version,
      })
      .execute();
  }, 60_000);

  afterAll(async () => {
    if (t !== undefined) {
      const jobIds = await t.db
        .selectFrom('render_job')
        .select('id')
        .where('work_id', '=', workId)
        .execute();
      if (jobIds.length > 0) {
        const ids = jobIds.map((job) => job.id);
        await t.db.deleteFrom('job_queue').where('job_id', 'in', ids).execute();
        await t.db.deleteFrom('render_job_event').where('job_id', 'in', ids).execute();
        await t.db.deleteFrom('render_job').where('id', 'in', ids).execute();
      }
      await t.db.deleteFrom('work').where('id', '=', workId).execute();
      if (cloneMaterialIds.length > 0) {
        await t.db.deleteFrom('material').where('id', 'in', cloneMaterialIds).execute();
      }
      await t.cleanup();
    }
  }, 60_000);

  it('unknown 素材产生真实阻断报告，G4 保持 false', async () => {
    const raw = await getJson<unknown>(
      `${t.baseUrl}/api/works/${workId}/compliance`,
      t.tokenA,
    );
    const report = ComplianceReportSchema.parse(raw);
    expect(report.blockingCount).toBe(1);
    const content = report.items.find((item) => item.kind === 'content');
    expect(content?.blocking).toBe(true);
    expect(content?.materialIds).toEqual([t.mat.p2]);
    expect((await envelopeOf(t, workId)).gates.G4).toBe(false);
  });

  it('绑定凭证不改全局素材，copy-on-write 后复检通过并解锁 G4', async () => {
    const response = await fetch(
      `${t.baseUrl}/api/works/${workId}/materials/${t.mat.p2}/license`,
      {
        method: 'POST',
        headers: auth(t.tokenA),
        body: JSON.stringify({
          evidenceType: 'commercial_use_grant',
          evidenceUrl: 'https://licenses.example.invalid/commercial.pdf',
        }),
      },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      materialId: string;
      report: ComplianceReport;
      envelope: WorkEnvelope;
    };
    cloneMaterialId = body.materialId;
    cloneMaterialIds.push(cloneMaterialId);
    expect(cloneMaterialId).not.toBe(t.mat.p2);
    expect(body.report.blockingCount).toBe(0);
    expect(body.envelope.gates.G4).toBe(true);

    const original = await t.db
      .selectFrom('material')
      .select(['user_id', 'license'])
      .where('id', '=', t.mat.p2)
      .executeTakeFirstOrThrow();
    expect(original.user_id).toBeNull();
    expect(original.license).toBe('unknown');
    const cloned = await t.db
      .selectFrom('material')
      .select(['user_id', 'license'])
      .where('id', '=', cloneMaterialId)
      .executeTakeFirstOrThrow();
    expect(cloned.user_id).toBe(t.seedUserId);
    expect(cloned.license).toBe('cleared');
    expect((await envelopeOf(t, workId)).gates.G4).toBe(true);
  });

  it('派生标题变化使旧报告指纹失效，force 复检生成新报告后恢复', async () => {
    await t.db
      .updateTable('derivative')
      .set({ title: '合规测试标题已修改' })
      .where('id', '=', `${workId}_dv`)
      .execute();
    expect((await envelopeOf(t, workId)).gates.G4).toBe(false);

    const raw = await getJson<unknown>(
      `${t.baseUrl}/api/works/${workId}/compliance?force=true`,
      t.tokenA,
    );
    const report = ComplianceReportSchema.parse(raw);
    expect(report.blockingCount).toBe(0);
    expect((await envelopeOf(t, workId)).gates.G4).toBe(true);
  });

  it('同类型素材替换保留 slides 引用，创建 0 点重算并可继续凭证修复', async () => {
    if (cloneMaterialId === undefined) throw new Error('前置克隆素材缺失');
    const response = await fetch(
      `${t.baseUrl}/api/works/${workId}/materials/${cloneMaterialId}/replace`,
      {
        method: 'POST',
        headers: auth(t.tokenA),
        body: JSON.stringify({ materialId: t.mat.p3 }),
      },
    );
    expect(response.status).toBe(200);
    const body = CollectMaterialResponse.parse(await response.json());
    expect(body.patchJob?.costPoints).toBe(0);
    expect(body.patchJob?.jobId).toBeDefined();

    const reference = await t.db
      .selectFrom('work_material')
      .select(['material_id', 'used_in'])
      .where('work_id', '=', workId)
      .executeTakeFirstOrThrow();
    expect(reference.material_id).toBe(t.mat.p3);
    expect(reference.used_in).toEqual([{ target: 'slides', pageId: 'p1' }]);
    const patchJob = await t.db
      .selectFrom('render_job')
      .select(['type', 'layer_scope', 'cost_points'])
      .where('id', '=', body.patchJob?.jobId ?? '')
      .executeTakeFirstOrThrow();
    expect(patchJob.type).toBe('patch');
    expect(patchJob.layer_scope).toEqual(['slides']);
    expect(patchJob.cost_points).toBe(0);

    const canceled = await fetch(`${t.baseUrl}/api/jobs/${body.patchJob?.jobId}:cancel`, {
      method: 'POST',
      headers: auth(t.tokenA),
    });
    expect(canceled.status).toBe(200);

    const licensed = await fetch(`${t.baseUrl}/api/works/${workId}/materials/${t.mat.p3}/license`, {
      method: 'POST',
      headers: auth(t.tokenA),
      body: JSON.stringify({
        evidenceType: 'commercial_use_grant',
        evidenceUrl: 'https://licenses.example.invalid/replacement.pdf',
      }),
    });
    expect(licensed.status).toBe(200);
    const licensedBody = (await licensed.json()) as { materialId: string };
    cloneMaterialId = licensedBody.materialId;
    cloneMaterialIds.push(cloneMaterialId);
    expect((await envelopeOf(t, workId)).gates.G4).toBe(true);
  });

  it('移除素材也是修复路径：复检后新指纹仍可通过', async () => {
    const response = await fetch(
      `${t.baseUrl}/api/works/${workId}/materials/${cloneMaterialId}`,
      { method: 'DELETE', headers: auth(t.tokenA) },
    );
    expect(response.status).toBe(200);
    const body = CollectMaterialResponse.parse(await response.json());
    expect(body.patchJob?.costPoints).toBe(0);
    expect(body.patchJob?.jobId).toBeDefined();
    const patchJob = await t.db
      .selectFrom('render_job')
      .select(['type', 'layer_scope', 'cost_points'])
      .where('id', '=', body.patchJob?.jobId ?? '')
      .executeTakeFirstOrThrow();
    expect(patchJob.type).toBe('patch');
    expect(patchJob.layer_scope).toEqual(['slides']);
    expect(patchJob.cost_points).toBe(0);
    expect((await envelopeOf(t, workId)).gates.G4).toBe(false);
    const report = ComplianceReportSchema.parse(
      await getJson(`${t.baseUrl}/api/works/${workId}/compliance?force=true`, t.tokenA),
    );
    expect(report.blockingCount).toBe(0);
    expect((await envelopeOf(t, workId)).gates.G4).toBe(true);
  });
});
