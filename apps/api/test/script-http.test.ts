/**
 * T-16/T-28～T-34 文案链路 E2E：真实 MySQL + 真实 Nest + 录制 LLM。
 * 使用种子 w1（已选选题、已收藏素材）；cleanup 只删除测试开始后新建的 script/style_sample，
 * 并还原 w1 与 style_profile，避免污染种子。
 */
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AutosaveConflict,
  JobSchema,
  PatchScriptRequest,
  ScriptLocked,
  ScriptSchema,
  StyleSampleSchema,
  type Script,
} from '@knowstudio/contracts';
import { seedId } from '@knowstudio/db';
import { createDiscoverTestApp, type DiscoverTestApp } from './discover-harness.js';

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

async function getScript(t: DiscoverTestApp): Promise<Script> {
  const res = await fetch(`${t.baseUrl}/api/works/${testWorkId}/script`, {
    headers: auth(t.tokenA),
  });
  expect(res.status).toBe(200);
  return ScriptSchema.parse(await res.json());
}

let testWorkId = '';

function patchBody(script: Script, mutate: (text: string) => string) {
  return PatchScriptRequest.parse({
    baseVersion: script.version,
    sections: script.sections.map((section) => ({
      kind: section.kind,
      lines: section.lines.map((line) => ({ id: line.id, ord: line.ord, text: mutate(line.text) })),
    })),
  });
}

describe('T-16/T-28～T-34 E2E：文案生成/编辑/风格/确认', () => {
  let t: DiscoverTestApp;
  let start: string;
  let originalProfile: {
    catchphrases: unknown;
    sentence_patterns: unknown;
    case_preferences: unknown;
    tone: string | null;
    sample_count: number;
    version: number;
    is_default: 0 | 1;
  };

  beforeAll(async () => {
    t = await createDiscoverTestApp();
    testWorkId = `w_script_${Math.random().toString(36).slice(2, 14)}`;
    start = new Date().toISOString().replace('T', ' ').replace('Z', '');
    originalProfile = await t.db
      .selectFrom('style_profile')
      .select([
        'catchphrases',
        'sentence_patterns',
        'case_preferences',
        'tone',
        'sample_count',
        'version',
        'is_default',
      ])
      .where('user_id', '=', t.seedUserId)
      .executeTakeFirstOrThrow();
    await t.db
      .insertInto('work')
      .values({
        id: testWorkId,
        user_id: t.seedUserId,
        title: '脚本链路测试作品',
        keyword: '费曼学习法',
        step: 'topics',
        phase: 1,
        selected_topic_id: `${testWorkId}_topic`,
      })
      .execute();
    await t.db
      .insertInto('topic_batch')
      .values({
        id: `${testWorkId}_batch`,
        work_id: testWorkId,
        user_id: t.seedUserId,
        batch_index: 1,
        based_on_material_ids: JSON.stringify([t.mat.k1]),
        hook_fingerprints: JSON.stringify([]),
        min_pairwise_cosine: null,
        regen_attempts: 0,
        effective_count: 1,
      })
      .execute();
    await t.db
      .insertInto('topic')
      .values({
        id: `${testWorkId}_topic`,
        batch_id: `${testWorkId}_batch`,
        work_id: testWorkId,
        hook: '脚本链路测试角度',
        angle: '脚本链路测试',
        blank_point: '测试文案生成闭环',
        basis_material_ids: JSON.stringify([t.mat.k1]),
        diversity_score: null,
        embedding: null,
        hook_fingerprint: 'a'.repeat(64),
        ord: 0,
      })
      .execute();
    for (const materialId of [t.mat.k1, t.mat.h1]) {
      await t.db
        .insertInto('work_material')
        .values({
          work_id: testWorkId,
          material_id: materialId,
          user_id: t.seedUserId,
          used_in: JSON.stringify([]),
        })
        .execute();
    }
  }, 60_000);

  afterAll(async () => {
    if (t === undefined) return;
    await t.db.deleteFrom('topic').where('work_id', '=', testWorkId).execute();
    await t.db.deleteFrom('work').where('id', '=', testWorkId).execute();
    await t.db.deleteFrom('topic_batch').where('id', '=', `${testWorkId}_batch`).execute();
    await t.db
      .deleteFrom('style_sample')
      .where('user_id', '=', t.seedUserId)
      .where('created_at', '>=', start)
      .execute();
    await t.db
      .updateTable('style_profile')
      .set({
        catchphrases: JSON.stringify(originalProfile.catchphrases),
        sentence_patterns: JSON.stringify(originalProfile.sentence_patterns),
        case_preferences: JSON.stringify(originalProfile.case_preferences),
        tone: originalProfile.tone,
        sample_count: originalProfile.sample_count,
        version: originalProfile.version,
        is_default: originalProfile.is_default,
      })
      .where('user_id', '=', t.seedUserId)
      .execute();
    await t.cleanup();
  }, 60_000);

  it('未选题的 w2 直调生成 → 409 G1；w1 生成 → 三段式且时长可见', async () => {
    const w2 = seedId('w', 'w2');
    const denied = await fetch(`${t.baseUrl}/api/works/${w2}/script:generate`, {
      method: 'POST',
      headers: auth(t.tokenA),
      body: '{}',
    });
    expect(denied.status).toBe(409);
    expect(((await denied.json()) as { code: string }).code).toBe('GATE_NOT_SATISFIED');

    const created = await fetch(`${t.baseUrl}/api/works/${testWorkId}/script:generate`, {
      method: 'POST',
      headers: auth(t.tokenA),
      body: '{}',
    });
    expect(created.status).toBe(202);
    expect(JobSchema.parse(await created.json()).status).toBe('succeeded');

    const script = await getScript(t);
    expect(script.status).toBe('draft');
    expect(script.sections.map((section) => section.kind)).toEqual(['hook3s', 'body', 'outro']);
    expect(script.estimatedDuration).not.toBeNull();
  }, 60_000);

  it('autosave 保存成功并落 revision；旧版本再保存 → 409 双版本', async () => {
    const before = await getScript(t);
    const saved = await fetch(`${t.baseUrl}/api/works/${testWorkId}/script`, {
      method: 'PATCH',
      headers: auth(t.tokenA),
      body: JSON.stringify(patchBody(before, (text) => `${text}（用户润色）`)),
    });
    expect(saved.status).toBe(200);
    const body = (await saved.json()) as { script: Script };
    expect(body.script.version).toBe(before.version + 1);

    const stale = await fetch(`${t.baseUrl}/api/works/${testWorkId}/script`, {
      method: 'PATCH',
      headers: auth(t.tokenA),
      body: JSON.stringify(patchBody(before, (text) => `${text}（旧版本）`)),
    });
    expect(stale.status).toBe(409);
    expect(AutosaveConflict.parse(await stale.json()).details.serverVersion).toBe(
      body.script.version,
    );

    const revisions = await t.db
      .selectFrom('script_revision')
      .select('id')
      .where('script_id', '=', body.script.id)
      .execute();
    expect(revisions.length).toBeGreaterThan(0);
  }, 60_000);

  it('风格样本可创建；restyle 产出句级 hunk，accept 后正文变化', async () => {
    const createdSample = await fetch(`${t.baseUrl}/api/style-samples`, {
      method: 'POST',
      headers: auth(t.tokenA),
      body: JSON.stringify({
        title: '我的风格样本',
        content: '我讲课喜欢直接说结论，再用身边案例解释，最后给一个行动。',
        source: 'paste',
      }),
    });
    expect(createdSample.status).toBe(202);
    const sample = StyleSampleSchema.parse(await createdSample.json());
    expect(sample.status).toBe('ready');

    const restyle = await fetch(`${t.baseUrl}/api/works/${testWorkId}/script:restyle`, {
      method: 'POST',
      headers: auth(t.tokenA),
      body: JSON.stringify({ sampleIds: [sample.id] }),
    });
    expect(restyle.status).toBe(200);
    const hunks = (
      (await restyle.json()) as {
        hunks: { id: string; lineId: string | null; rewritten: string }[];
      }
    ).hunks;
    expect(hunks.length).toBeGreaterThan(0);

    const before = await getScript(t);
    const accepted = await fetch(
      `${t.baseUrl}/api/works/${testWorkId}/script/hunks/${hunks[0]!.id}:accept`,
      { method: 'POST', headers: auth(t.tokenA) },
    );
    expect(accepted.status).toBe(200);
    const acceptedBody = (await accepted.json()) as { script: Script };
    expect(acceptedBody.script.version).toBe(before.version + 1);
    expect(
      acceptedBody.script.sections.some((section) =>
        section.lines.some(
          (line) => line.id === hunks[0]!.lineId && line.text === hunks[0]!.rewritten,
        ),
      ),
    ).toBe(true);
  }, 60_000);

  it('确认 → G2 true 并进入视频步；确认后编辑 → 409；解锁 → G2 false', async () => {
    const confirmedRes = await fetch(`${t.baseUrl}/api/works/${testWorkId}/script:confirm`, {
      method: 'POST',
      headers: auth(t.tokenA),
    });
    expect(confirmedRes.status).toBe(200);
    const confirmed = (await confirmedRes.json()) as {
      envelope: { gates: { G2: boolean }; step: string };
    };
    expect(confirmed.envelope.gates.G2).toBe(true);
    expect(confirmed.envelope.step).toBe('video.draft');

    const script = await getScript(t);
    const locked = await fetch(`${t.baseUrl}/api/works/${testWorkId}/script`, {
      method: 'PATCH',
      headers: auth(t.tokenA),
      body: JSON.stringify(patchBody(script, (text) => `${text}（锁定后）`)),
    });
    expect(locked.status).toBe(409);
    expect(ScriptLocked.parse(await locked.json()).code).toBe('SCRIPT_LOCKED');

    const unlocked = await fetch(`${t.baseUrl}/api/works/${testWorkId}/script:unlock`, {
      method: 'POST',
      headers: auth(t.tokenA),
    });
    expect(unlocked.status).toBe(200);
    const unlockedBody = (await unlocked.json()) as { envelope: { gates: { G2: boolean } } };
    expect(unlockedBody.envelope.gates.G2).toBe(false);
    expect((await getScript(t)).status).toBe('stale');
  }, 60_000);

  it('跨用户读取/修改文案 → 404', async () => {
    const read = await fetch(`${t.baseUrl}/api/works/${testWorkId}/script`, {
      headers: auth(t.tokenB),
    });
    expect(read.status).toBe(404);
    const patch = await fetch(`${t.baseUrl}/api/works/${testWorkId}/script`, {
      method: 'PATCH',
      headers: auth(t.tokenB),
      body: JSON.stringify({ baseVersion: 1, sections: [] }),
    });
    expect(patch.status).toBe(404);
  }, 60_000);
});
