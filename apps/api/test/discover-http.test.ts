/**
 * T-20/T-21 discover/library HTTP E2E —— **真实 MySQL 8 + 真实 Redis 7 + 进程内 Nest + listen(0) + 真实 fetch**。
 *
 * 装配见 discover-harness.ts：只 override 三个基础设施令牌 + OBJECT_STORAGE 桩，
 * 闸门/配额真相端口（WORK_TRUTH_SNAPSHOT / WORK_QUOTA_READER）与搜索端口（SOURCE_REGISTRY / LLM_PORT / 三仓储）
 * 全部走 app.module 默认的**真实生产绑定**（dev 录制 VCR）。故本 E2E 跑的是真实链路，不是替身拼的假装配（守 D-04/D-22）。
 *
 * 覆盖 DoD：
 *  1. 搜索主链路：POST 202 受理 → 1s 轮询 GET succeeded；真实 10 条聚合素材（8 自有 + 2 全局）；
 *     **输入驱动饱和度 score=61（绝不是常量 72，D-08 点名缺陷）**；3 个带依据的空白角度（依据 ⊆ 真实素材 id）；
 *     collected 按当前 work 叠加；24h 缓存命中 200 + cacheHit true；force 绕过缓存 202 新 id。
 *  2. 诚实空态：未录制关键词 → succeeded + 空素材 + saturation null + blankAngles[]（不是故障，D-08）。
 *  3. 素材库：visible()=10（[待确认 #16] SPEC §3.9「8」与全局池口径分歧，本层忠实反映仓储语义）；
 *     collected 用户级叠加（D-21）；type/license/q 过滤；游标分页无重叠无遗漏；非法游标 400。
 *  4. 收藏：幂等 collect/uncollect 净零；collectedCount 与 envelope 同源真实（闸门 deriveGates 派生，G1 据实 true）。
 *  5. 鉴权链序：无 token 一律 401 UNAUTHENTICATED（AuthGuard 先于 OwnershipGuard）。
 *  6. 跨用户隔离 + 防枚举：B 搜 A 的 work / B 读 A 的会话 / 不存在资源 全部 404（不是 403），
 *     且「不属于你」与「不存在」的会话 404 响应体逐字节相同（架构 §13）。
 *  7. DTO 校验：空 keyword / 缺 workId / limit=0 / 非法 type / 非法 cursor 一律 400 VALIDATION_FAILED。
 *
 * 并行污染纪律：不新建 work/material；search_session 不在任何全局计数里（cleanup 按 created_at>=起点精确删）；
 * collect/uncollect 净零；只新建 1 行 app_user B（无全局计数，cleanup 删）。每个 POST search 都轮询到终态再结束用例。
 */
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CollectMaterialResponse,
  MaterialSchema,
  SearchAccepted,
  SearchSessionSchema,
  WorkEnvelopeSchema,
  type SearchSession,
} from '@knowstudio/contracts';
import { createDiscoverTestApp, type DiscoverTestApp } from './discover-harness.js';

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 轮询 GET /discover/search/:id 到终态（succeeded/failed/canceled）。录制适配器瞬时，通常首轮即终态。 */
async function pollSession(t: DiscoverTestApp, token: string, id: string): Promise<SearchSession> {
  for (let i = 0; i < 250; i += 1) {
    const res = await fetch(`${t.baseUrl}/api/discover/search/${id}`, { headers: auth(token) });
    if (res.status !== 200) {
      throw new Error(
        `轮询 GET /discover/search/${id} 失败 status=${res.status} body=${await res.text()}`,
      );
    }
    const session = SearchSessionSchema.parse(await res.json());
    if (
      session.status === 'succeeded' ||
      session.status === 'failed' ||
      session.status === 'canceled'
    ) {
      return session;
    }
    await delay(20);
  }
  throw new Error(`搜索会话 ${id} 轮询 5s 仍未到终态`);
}

/** POST search 受理（断言 202 + cacheHit false）→ 轮询到终态，返回 {id, session}。 */
async function acceptAndPoll(
  t: DiscoverTestApp,
  token: string,
  body: Record<string, unknown>,
): Promise<{ id: string; session: SearchSession }> {
  const res = await fetch(`${t.baseUrl}/api/discover/search`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(202);
  const accepted = SearchAccepted.parse(await res.json());
  expect(accepted.cacheHit).toBe(false);
  const session = await pollSession(t, token, accepted.searchId);
  return { id: accepted.searchId, session };
}

describe('T-20/T-21 E2E：搜索主链路 + 缓存 + 诚实空态（真实生产装配）', () => {
  let t: DiscoverTestApp;

  beforeAll(async () => {
    t = await createDiscoverTestApp();
  }, 60_000);

  afterAll(async () => {
    await t?.cleanup();
  }, 60_000);

  it('★搜索主链路：202→轮询 succeeded，真实 10 素材 + 输入驱动饱和度(=61≠72) + 3 空白角度 + collected 叠加 + 缓存命中 + force', async () => {
    // force：本地持久库可能残留 24h 内的同关键词会话，先确保拿到新会话。
    const { id: id1, session } = await acceptAndPoll(t, t.tokenA, {
      workId: t.workId,
      keyword: '费曼学习法',
      force: true,
    });
    expect(id1.startsWith('ss_')).toBe(true);
    expect(session.id).toBe(id1);
    expect(session.keyword).toBe('费曼学习法');
    expect(session.status).toBe('succeeded');
    expect(session.cacheHit).toBe(false);
    expect(session.partialErrors).toEqual([]);

    // 真实 10 条聚合素材（knowledge 4 + hot 3 + peer 3），id 与库内种子行同源。
    expect(session.materials).toHaveLength(10);
    const allMatIds = Object.values(t.mat);
    expect(new Set(session.materials.map((m) => m.id))).toEqual(new Set(allMatIds));
    for (const m of session.materials) MaterialSchema.parse(m);

    // collected 按会话所属 work（w1 初始 {k1,h1}）叠加，适配器不谎报收藏。
    const byId = new Map(session.materials.map((m) => [m.id, m]));
    expect(byId.get(t.mat.k1)?.collected).toBe(true);
    expect(byId.get(t.mat.h1)?.collected).toBe(true);
    expect(byId.get(t.mat.k4)?.collected).toBe(false);
    expect(byId.get(t.mat.p2)?.collected).toBe(false);

    // ★D-08：饱和度由真实聚合素材算出（weighted=3·3+3·2+4·1=19 → round(1900/31)=61），绝不是常量 72。
    expect(session.saturation).not.toBeNull();
    const sat = session.saturation!;
    expect(sat.score).toBe(61);
    expect(sat.score).not.toBe(72);
    expect(sat.level).toBe('has_room');
    expect(sat.confidence).toBe(0.75);
    expect(sat.sampleSize).toBe(10);
    expect(sat.sufficient).toBe(true);
    expect(sat.coveredPlatforms).toEqual(['douyin', 'bili', 'xhs']);
    expect(sat.sources).toHaveLength(7);
    expect(sat.sources).toContain('书籍《认知天性》');

    // 空白角度：3 个结构（带 id/依据/rationale），数据驱动自种子真实选题 t07/t08/t09，依据 ⊆ 真实素材 id 且非空。
    expect(session.blankAngles).toHaveLength(3);
    expect(session.blankAngles.map((a) => a.label)).toEqual([
      '费曼×职场汇报',
      '费曼×「假装努力」热点',
      '费曼×卡片笔记',
    ]);
    const matIdSet = new Set(allMatIds);
    for (const a of session.blankAngles) {
      expect(a.id.length).toBeGreaterThan(0);
      expect(a.basisMaterialIds.length).toBeGreaterThan(0);
      for (const bid of a.basisMaterialIds) expect(matIdSet.has(bid)).toBe(true);
      expect(a.rationale.length).toBeGreaterThan(0);
    }
    expect(session.blankAngles[0]!.basisMaterialIds).toContain(t.mat.k1);

    // 24h 缓存命中：第二次非 force → 200 + 同 id + cacheHit true（复验形状合法）。
    const second = await fetch(`${t.baseUrl}/api/discover/search`, {
      method: 'POST',
      headers: auth(t.tokenA),
      body: JSON.stringify({ workId: t.workId, keyword: '费曼学习法' }),
    });
    expect(second.status).toBe(200);
    const hit = SearchSessionSchema.parse(await second.json());
    expect(hit.id).toBe(id1);
    expect(hit.cacheHit).toBe(true);
    expect(hit.materials).toHaveLength(10);
    expect(hit.saturation?.score).toBe(61);

    // force：绕过缓存 → 202 新 id ≠ id1 → 轮询 succeeded + cacheHit false。
    const { id: id2, session: session2 } = await acceptAndPoll(t, t.tokenA, {
      workId: t.workId,
      keyword: '费曼学习法',
      force: true,
    });
    expect(id2).not.toBe(id1);
    expect(session2.status).toBe('succeeded');
    expect(session2.cacheHit).toBe(false);
    expect(session2.materials).toHaveLength(10);
  });

  it('★诚实空态：未录制关键词 → succeeded + 空素材 + saturation null + blankAngles[]（不是故障，D-08）', async () => {
    const { session } = await acceptAndPoll(t, t.tokenA, {
      workId: t.workId,
      keyword: '量子纠缠',
      force: true,
    });
    expect(session.status).toBe('succeeded');
    expect(session.materials).toEqual([]);
    expect(session.saturation).toBeNull();
    expect(session.blankAngles).toEqual([]);
    // 源健康但无命中是 empty，不是 error：无 partial 噪声，也不触发未录制 LLM 的 NO_RECORDING。
    expect(session.partialErrors).toEqual([]);
    expect(session.cacheHit).toBe(false);
  });
});

describe('T-21 E2E：素材库列表 + 过滤 + 游标分页 + collected 用户级叠加', () => {
  let t: DiscoverTestApp;

  beforeAll(async () => {
    t = await createDiscoverTestApp();
  }, 60_000);

  afterAll(async () => {
    await t?.cleanup();
  }, 60_000);

  it('GET /library → 200 {items,nextCursor,total}，visible()=10（8 自有 + 2 全局），collected 用户级 {k1,h1}', async () => {
    const res = await fetch(`${t.baseUrl}/api/library?limit=100`, { headers: auth(t.tokenA) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: unknown[];
      nextCursor: string | null;
      total: number;
    };
    // [待确认 #16] SPEC §3.9「素材库 8」vs 仓储 visible()（自有 OR 全局）=10：本层忠实反映仓储语义，分歧归 #16。
    expect(body.total).toBe(10);
    expect(body.items).toHaveLength(10);
    expect(body.nextCursor).toBeNull();
    const items = body.items.map((i) => MaterialSchema.parse(i));
    expect(new Set(items.map((i) => i.id))).toEqual(new Set(Object.values(t.mat)));
    const byId = new Map(items.map((i) => [i.id, i]));
    expect(byId.get(t.mat.k1)?.collected).toBe(true);
    expect(byId.get(t.mat.h1)?.collected).toBe(true);
    expect(byId.get(t.mat.k4)?.collected).toBe(false);
    // 全局公共库素材（p2/p3）也可见，但未被收藏。
    expect(byId.get(t.mat.p2)?.collected).toBe(false);
    expect(byId.get(t.mat.p3)?.collected).toBe(false);
  });

  it('过滤：type=knowledge→4 / license=cleared→2 / q=费曼→3（标题 LIKE 子串，含全局 p3）', async () => {
    const knowledge = await fetch(`${t.baseUrl}/api/library?type=knowledge&limit=100`, {
      headers: auth(t.tokenA),
    });
    expect(knowledge.status).toBe(200);
    const kBody = (await knowledge.json()) as { items: { id: string }[]; total: number };
    expect(kBody.total).toBe(4);
    expect(new Set(kBody.items.map((i) => i.id))).toEqual(
      new Set([t.mat.k1, t.mat.k2, t.mat.k3, t.mat.k4]),
    );

    const cleared = await fetch(`${t.baseUrl}/api/library?license=cleared&limit=100`, {
      headers: auth(t.tokenA),
    });
    expect(cleared.status).toBe(200);
    const cBody = (await cleared.json()) as { items: { id: string }[]; total: number };
    expect(cBody.total).toBe(2);
    expect(new Set(cBody.items.map((i) => i.id))).toEqual(new Set([t.mat.k1, t.mat.k4]));

    const q = await fetch(`${t.baseUrl}/api/library?q=${encodeURIComponent('费曼')}&limit=100`, {
      headers: auth(t.tokenA),
    });
    expect(q.status).toBe(200);
    const qBody = (await q.json()) as { items: { id: string }[]; total: number };
    expect(qBody.total).toBe(3);
    expect(new Set(qBody.items.map((i) => i.id))).toEqual(new Set([t.mat.k1, t.mat.p1, t.mat.p3]));
  });

  it('★游标分页：limit=5 → 两页翻完 10 条，无重叠无遗漏，末页 nextCursor=null', async () => {
    const full = (await (
      await fetch(`${t.baseUrl}/api/library?limit=100`, { headers: auth(t.tokenA) })
    ).json()) as { items: { id: string }[] };
    const fullIds = new Set(full.items.map((i) => i.id));
    expect(fullIds.size).toBe(10);

    const page1Res = await fetch(`${t.baseUrl}/api/library?limit=5`, { headers: auth(t.tokenA) });
    expect(page1Res.status).toBe(200);
    const page1 = (await page1Res.json()) as {
      items: { id: string }[];
      nextCursor: string | null;
      total: number;
    };
    expect(page1.total).toBe(10);
    expect(page1.items).toHaveLength(5);
    expect(page1.nextCursor).not.toBeNull();

    const page2Res = await fetch(
      `${t.baseUrl}/api/library?limit=5&cursor=${encodeURIComponent(page1.nextCursor!)}`,
      { headers: auth(t.tokenA) },
    );
    expect(page2Res.status).toBe(200);
    const page2 = (await page2Res.json()) as { items: { id: string }[]; nextCursor: string | null };
    expect(page2.items).toHaveLength(5);
    expect(page2.nextCursor).toBeNull();

    const ids1 = page1.items.map((i) => i.id);
    const ids2 = page2.items.map((i) => i.id);
    // 无重叠
    for (const id of ids2) expect(ids1.includes(id)).toBe(false);
    // 无遗漏：两页并集恰好等于全量 10 条
    expect(new Set([...ids1, ...ids2])).toEqual(fullIds);
  });

  it('非法游标 → 400 VALIDATION_FAILED，fields[0].path=cursor（客户端输入错误，不是 500）', async () => {
    const res = await fetch(`${t.baseUrl}/api/library?cursor=not-a-cursor`, {
      headers: auth(t.tokenA),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; details: { fields: { path: string }[] } };
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.details.fields[0]?.path).toBe('cursor');
  });
});

describe('T-20 E2E：收藏幂等 + collectedCount/envelope 同源真实（闸门派生）', () => {
  let t: DiscoverTestApp;

  beforeAll(async () => {
    t = await createDiscoverTestApp();
  }, 60_000);

  afterAll(async () => {
    await t?.cleanup();
  }, 60_000);

  it('★collect/uncollect 净零 + 幂等：k4 2→3→2、全局 p2 2→3→2、重复 collect k1 仍 2；envelope 闸门据实 G1=true', async () => {
    const post = (materialId: string) =>
      fetch(`${t.baseUrl}/api/works/${t.workId}/materials`, {
        method: 'POST',
        headers: auth(t.tokenA),
        body: JSON.stringify({ materialId }),
      });
    const del = (materialId: string) =>
      fetch(`${t.baseUrl}/api/works/${t.workId}/materials/${materialId}`, {
        method: 'DELETE',
        headers: auth(t.tokenA),
      });

    // 收藏自有 k4（初始未收藏）→ 3，信封合法且闸门据实派生（w1 有选中选题 → G1 true）。
    const c1 = await post(t.mat.k4);
    expect(c1.status).toBe(200);
    const r1 = CollectMaterialResponse.parse(await c1.json());
    expect(r1.collectedCount).toBe(3);
    const env1 = WorkEnvelopeSchema.parse(r1.envelope);
    expect(env1.id).toBe(t.workId);
    expect(env1.step).toBe('script');
    expect(env1.gates.G1).toBe(true);
    expect(env1.quota.left).toBe(env1.quota.total - env1.quota.used - env1.quota.reserved);

    // 取消 k4 → 回到 2（净零）。
    const d1 = await del(t.mat.k4);
    expect(d1.status).toBe(200);
    expect(CollectMaterialResponse.parse(await d1.json()).collectedCount).toBe(2);

    // 收藏全局公共库 p2（user_id NULL，可见）→ 3；取消 → 2。
    const c2 = await post(t.mat.p2);
    expect(c2.status).toBe(200);
    expect(CollectMaterialResponse.parse(await c2.json()).collectedCount).toBe(3);
    const d2 = await del(t.mat.p2);
    expect(d2.status).toBe(200);
    expect(CollectMaterialResponse.parse(await d2.json()).collectedCount).toBe(2);

    // 幂等：k1 初始已收藏，重复 collect 不增行、不报错 → 仍 2。
    const c3 = await post(t.mat.k1);
    expect(c3.status).toBe(200);
    expect(CollectMaterialResponse.parse(await c3.json()).collectedCount).toBe(2);

    // 幂等取消：原本未收藏的 k4 再删 → 200 + 仍 2（false 不报错）。
    const d3 = await del(t.mat.k4);
    expect(d3.status).toBe(200);
    expect(CollectMaterialResponse.parse(await d3.json()).collectedCount).toBe(2);
  });
});

describe('T-20/T-21 E2E：鉴权链序 401 + 跨用户隔离 404 + 防枚举 + DTO 校验 400', () => {
  let t: DiscoverTestApp;

  beforeAll(async () => {
    t = await createDiscoverTestApp();
  }, 60_000);

  afterAll(async () => {
    await t?.cleanup();
  }, 60_000);

  it('★无 token 一律 401 UNAUTHENTICATED（AuthGuard 先于 OwnershipGuard，含 loginUrl）', async () => {
    const noAuth = { 'content-type': 'application/json' };
    const attempts = await Promise.all([
      fetch(`${t.baseUrl}/api/discover/search`, {
        method: 'POST',
        headers: noAuth,
        body: JSON.stringify({ workId: t.workId, keyword: '费曼学习法' }),
      }),
      fetch(`${t.baseUrl}/api/discover/search/ss_0000000000000000000000000000dead`, {
        headers: noAuth,
      }),
      fetch(`${t.baseUrl}/api/library`, { headers: noAuth }),
      fetch(`${t.baseUrl}/api/works/${t.workId}/materials`, {
        method: 'POST',
        headers: noAuth,
        body: JSON.stringify({ materialId: t.mat.k1 }),
      }),
      fetch(`${t.baseUrl}/api/works/${t.workId}/materials/${t.mat.k1}`, {
        method: 'DELETE',
        headers: noAuth,
      }),
    ]);
    for (const res of attempts) {
      expect(res.status).toBe(401);
      const body = (await res.json()) as { code: string; details: { loginUrl: string } };
      expect(body.code).toBe('UNAUTHENTICATED');
      expect(body.details.loginUrl).toBe('/login');
    }
  });

  it('★跨用户隔离 + 防枚举：B 搜 A 的 work / B 读 A 的会话 / 不存在会话 全部 404，且会话 404 体逐字节相同', async () => {
    // B 用 A 的 workId 搜索：服务先校验 work 归属 → null → 404，B 不落任何行。
    const bSearch = await fetch(`${t.baseUrl}/api/discover/search`, {
      method: 'POST',
      headers: auth(t.tokenB),
      body: JSON.stringify({ workId: t.workId, keyword: '费曼学习法' }),
    });
    expect(bSearch.status).toBe(404);
    expect(bSearch.status).not.toBe(403);
    expect(((await bSearch.json()) as { code: string }).code).toBe('NOT_FOUND');

    // B 收藏 A 的 work：OwnershipGuard 按 userId 作用域查不到 → 404（不是 403）。
    const bCollect = await fetch(`${t.baseUrl}/api/works/${t.workId}/materials`, {
      method: 'POST',
      headers: auth(t.tokenB),
      body: JSON.stringify({ materialId: t.mat.k1 }),
    });
    expect(bCollect.status).toBe(404);
    expect(((await bCollect.json()) as { code: string }).code).toBe('NOT_FOUND');

    // A 建一个会话（force 确保新 id）并落终态，供 B 跨用户读取负向。
    const { id: aId } = await acceptAndPoll(t, t.tokenA, {
      workId: t.workId,
      keyword: '费曼学习法',
      force: true,
    });

    // B 读 A 的会话 → user_id 作用域 → null → 404。
    const bGet = await fetch(`${t.baseUrl}/api/discover/search/${aId}`, {
      headers: auth(t.tokenB),
    });
    expect(bGet.status).toBe(404);
    // A 读不存在的会话（合法格式 id）→ 404。
    const ghost = await fetch(
      `${t.baseUrl}/api/discover/search/ss_0000000000000000000000000000dead`,
      {
        headers: auth(t.tokenA),
      },
    );
    expect(ghost.status).toBe(404);

    // 「不属于你」与「根本不存在」的会话 404 响应体逐字节相同 → 无法用状态差/文案差枚举有效会话 id。
    const bBody = await bGet.text();
    const ghostBody = await ghost.text();
    expect(bBody).toBe(ghostBody);
    expect(JSON.parse(bBody)).toEqual({
      code: 'NOT_FOUND',
      message: '资源不存在或不属于你',
      details: {},
    });

    // A 搜不存在的 work → 404（work 归属校验）。
    const ghostWork = await fetch(`${t.baseUrl}/api/discover/search`, {
      method: 'POST',
      headers: auth(t.tokenA),
      body: JSON.stringify({ workId: 'w_0000000000000000000000000000dead', keyword: '费曼学习法' }),
    });
    expect(ghostWork.status).toBe(404);
    expect(((await ghostWork.json()) as { code: string }).code).toBe('NOT_FOUND');
  });

  it('DTO 校验：空 keyword / 缺 workId / limit=0 / 非法 type 一律 400 VALIDATION_FAILED', async () => {
    const emptyKeyword = await fetch(`${t.baseUrl}/api/discover/search`, {
      method: 'POST',
      headers: auth(t.tokenA),
      body: JSON.stringify({ workId: t.workId, keyword: '' }),
    });
    expect(emptyKeyword.status).toBe(400);
    expect(((await emptyKeyword.json()) as { code: string }).code).toBe('VALIDATION_FAILED');

    const missingWork = await fetch(`${t.baseUrl}/api/discover/search`, {
      method: 'POST',
      headers: auth(t.tokenA),
      body: JSON.stringify({ keyword: '费曼学习法' }),
    });
    expect(missingWork.status).toBe(400);
    const mwBody = (await missingWork.json()) as {
      code: string;
      details: { fields: { path: string }[] };
    };
    expect(mwBody.code).toBe('VALIDATION_FAILED');
    expect(mwBody.details.fields.some((f) => f.path === 'workId')).toBe(true);

    const badLimit = await fetch(`${t.baseUrl}/api/library?limit=0`, { headers: auth(t.tokenA) });
    expect(badLimit.status).toBe(400);

    const badType = await fetch(`${t.baseUrl}/api/library?type=invalid`, {
      headers: auth(t.tokenA),
    });
    expect(badType.status).toBe(400);
    expect(((await badType.json()) as { code: string }).code).toBe('VALIDATION_FAILED');
  });
});
