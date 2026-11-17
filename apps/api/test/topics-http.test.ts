/**
 * T-24～T-27 选题 HTTP E2E：真实 MySQL + 真实 Nest + 录制 LLM/Embedding。
 *
 * 种子 w1 已有一批选题，因此 generate 幂等返回既有批次；reroll 会新建批次。
 * cleanup 只删除 batch_index > 1 的测试批次，并还原 w1 的 selected_topic_id / step。
 */
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  JobSchema,
  RerollAccepted,
  TopicBatchSchema,
  WorkEnvelopeSchema,
} from '@knowstudio/contracts';
import { createDiscoverTestApp, type DiscoverTestApp } from './discover-harness.js';

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

async function json(res: Response): Promise<unknown> {
  return res.json();
}

describe('T-24～T-27 E2E：选题生成 / 换一批 / 选定 G1', () => {
  let t: DiscoverTestApp;
  let originalSelectedTopicId: string | null;
  let originalStep: string;

  beforeAll(async () => {
    t = await createDiscoverTestApp();
    const work = await t.db
      .selectFrom('work')
      .select(['selected_topic_id', 'step'])
      .where('id', '=', t.workId)
      .executeTakeFirstOrThrow();
    originalSelectedTopicId = work.selected_topic_id;
    originalStep = work.step;
  }, 60_000);

  afterAll(async () => {
    if (t === undefined) return;
    await t.db
      .deleteFrom('topic_batch')
      .where('work_id', '=', t.workId)
      .where('batch_index', '>', 1)
      .execute();
    await t.db
      .updateTable('work')
      .set({ selected_topic_id: originalSelectedTopicId, step: originalStep as never })
      .where('id', '=', t.workId)
      .execute();
    await t.cleanup();
  }, 60_000);

  it('首批生成幂等返回种子批次，GET 读取 12 条且依据有效', async () => {
    const created = await fetch(`${t.baseUrl}/api/works/${t.workId}/topics:generate`, {
      method: 'POST',
      headers: auth(t.tokenA),
      body: JSON.stringify({ materialIds: t.initialCollected }),
    });
    expect(created.status).toBe(202);
    expect(JobSchema.parse(await json(created)).status).toBe('succeeded');

    const res = await fetch(`${t.baseUrl}/api/works/${t.workId}/topics`, {
      headers: auth(t.tokenA),
    });
    expect(res.status).toBe(200);
    const batch = TopicBatchSchema.parse(await json(res));
    expect(batch.batchIndex).toBe(1);
    expect(batch.topics).toHaveLength(12);
    for (const topic of batch.topics) expect(topic.basisMaterialIds.length).toBeGreaterThan(0);
  }, 60_000);

  it('换一批真实新建批次：hook 指纹不重叠，embedding 1024 维，cosine ≤0.75', async () => {
    const first = TopicBatchSchema.parse(
      await json(
        await fetch(`${t.baseUrl}/api/works/${t.workId}/topics`, { headers: auth(t.tokenA) }),
      ),
    );
    const firstFingerprints = new Set(first.topics.map((topic) => topic.hookFingerprint));

    const reroll = await fetch(`${t.baseUrl}/api/works/${t.workId}/topics:reroll`, {
      method: 'POST',
      headers: auth(t.tokenA),
    });
    if (reroll.status !== 202) console.error('REROLL_BODY', await reroll.text());
    expect(reroll.status).toBe(202);
    expect(RerollAccepted.parse(await json(reroll)).batchIndex).toBe(2);

    const secondRes = await fetch(`${t.baseUrl}/api/works/${t.workId}/topics`, {
      headers: auth(t.tokenA),
    });
    const second = TopicBatchSchema.parse(await json(secondRes));
    expect(second.batchIndex).toBe(2);
    expect(second.topics).toHaveLength(12);
    expect(second.topics.every((topic) => !firstFingerprints.has(topic.hookFingerprint))).toBe(
      true,
    );
    expect(second.minPairwiseCosine).not.toBeNull();
    expect(second.minPairwiseCosine!).toBeLessThanOrEqual(0.75);

    const rows = await t.db
      .selectFrom('topic')
      .select(['embedding'])
      .where('batch_id', '=', second.id)
      .execute();
    expect(rows).toHaveLength(12);
    for (const row of rows) expect(row.embedding).toHaveLength(1024);
  }, 60_000);

  it('选定新批次角度 → selectedTopicId 变化且 G1=true、step 进入 script', async () => {
    const before = WorkEnvelopeSchema.parse(
      await json(await fetch(`${t.baseUrl}/api/works/${t.workId}`, { headers: auth(t.tokenA) })),
    );
    const batch = TopicBatchSchema.parse(
      await json(
        await fetch(`${t.baseUrl}/api/works/${t.workId}/topics`, { headers: auth(t.tokenA) }),
      ),
    );
    const topic =
      batch.topics.find((item) => item.id !== before.selectedTopicId) ?? batch.topics[0]!;
    const direct = await t.db
      .selectFrom('topic')
      .select(['id', 'work_id', 'batch_id'])
      .where('id', '=', topic.id)
      .executeTakeFirst();
    expect(direct?.work_id).toBe(t.workId);

    const res = await fetch(`${t.baseUrl}/api/works/${t.workId}/topic:select`, {
      method: 'POST',
      headers: auth(t.tokenA),
      body: JSON.stringify({ topicId: topic.id }),
    });
    if (res.status !== 200) console.error('SELECT_BODY', await res.text());
    expect(res.status).toBe(200);
    const envelope = WorkEnvelopeSchema.parse(await json(res));
    expect(envelope.selectedTopicId).toBe(topic.id);
    expect(envelope.gates.G1).toBe(true);
    expect([
      'script',
      'video.draft',
      'video.rendering',
      'video.rendered',
      'derive',
      'export',
      'done',
    ]).toContain(envelope.step);
  }, 60_000);

  it('输入未收藏素材 → 400；跨用户读取与选择 → 404', async () => {
    const bad = await fetch(`${t.baseUrl}/api/works/${t.workId}/topics:generate`, {
      method: 'POST',
      headers: auth(t.tokenA),
      body: JSON.stringify({ materialIds: [t.mat.p2] }),
    });
    expect(bad.status).toBe(400);
    expect(((await json(bad)) as { code: string }).code).toBe('VALIDATION_FAILED');

    const crossRead = await fetch(`${t.baseUrl}/api/works/${t.workId}/topics`, {
      headers: auth(t.tokenB),
    });
    expect(crossRead.status).toBe(404);

    const crossSelect = await fetch(`${t.baseUrl}/api/works/${t.workId}/topic:select`, {
      method: 'POST',
      headers: auth(t.tokenB),
      body: JSON.stringify({ topicId: 't_0000000000000000000000000000dead' }),
    });
    expect(crossSelect.status).toBe(404);
  }, 60_000);
});
