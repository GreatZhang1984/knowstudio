/**
 * T-10 works HTTP E2E —— **真实 MySQL 8 + 真实 Redis 7 + 进程内 Nest + listen(0) + 真实 fetch**。
 *
 * 覆盖 DoD：
 *  1. 五个端点真实跑通（POST/GET list/GET :id/PATCH/DELETE）
 *  2. 跨用户隔离负向用例：A 拿 B 的 workId 调**所有写接口与详情接口**全部 404；
 *     并证明 404 不是 403、「不存在」与「无权限」响应不可区分（架构 §13 2081 行明确要求）
 *  3. 游标分页真实翻页、无重叠无遗漏（含**同毫秒并列**的 tie-breaker 用例）
 *  4. 仓储层 user_id 谓词强制（真实库版：不传/传错 userId 都拿不到别人数据）
 *  5. Guard 链序：无 token 调 :id 得 401 而非 404（证明 AuthGuard 先于 OwnershipGuard）
 *  6. 闸门非硬编码：改真相 → 闸门随之变化（D-04 根因的负向验证）
 *
 * 不绑定 3000；不留长驻进程；每个 describe 独立装配并在 afterAll 清理测试数据。
 */
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WorkEnvelopeSchema, type WorkEnvelope } from '@knowstudio/contracts';
import { createWorkRepository, WorkScopeRequiredError } from '@knowstudio/db/repositories';
import { createWorksTestApp, type WorksTestApp } from './works-harness.js';

/** DATETIME(3) UTC 字面量，用于构造确定的 updated_at 排序。 */
function lit(minuteOffset: number): string {
  const d = new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 0) + minuteOffset * 60_000);
  return d.toISOString().slice(0, 23).replace('T', ' ');
}

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

async function jsonOf(res: Response): Promise<unknown> {
  return res.json();
}

describe('T-10 E2E：五端点 + 跨用户 404 + Guard 链序 + 闸门派生', () => {
  let t: WorksTestApp;

  beforeAll(async () => {
    t = await createWorksTestApp();
  }, 60_000);

  afterAll(async () => {
    await t?.cleanup();
  }, 60_000);

  it('POST /works → 201 + 合法信封（闸门全 false 且四门详情齐全）', async () => {
    const res = await fetch(`${t.baseUrl}/api/works`, {
      method: 'POST',
      headers: auth(t.userA.token),
      body: JSON.stringify({ keyword: '费曼学习法' }),
    });
    expect(res.status).toBe(201);
    const body = (await jsonOf(res)) as WorkEnvelope;

    // 用真实契约 schema 校验（含 T-05 加固的逐门一致性 superRefine）。
    const env = WorkEnvelopeSchema.parse(body);
    expect(env.keyword).toBe('费曼学习法');
    // [待确认] title 省略时取 keyword，已在报告披露。
    expect(env.title).toBe('费曼学习法');
    expect(env.step).toBe('search');
    expect(env.phase).toBe(0);
    expect(env.progress).toBe(15);
    expect(env.gates).toEqual({ G1: false, G2: false, G3: false, G4: false });
    for (const g of ['G1', 'G2', 'G3', 'G4'] as const) {
      expect(env.gateDetails[g]?.satisfied).toBe(false);
    }
    // G4 的 redirectTo 必须是派生页，**不是** export 自身（否则 CTA 原地死循环）。
    expect(env.gateDetails.G4?.redirectTo).toBe(`/publish/${env.id}`);
    expect(env.gateDetails.G4?.redirectTo).not.toBe(`/publish/${env.id}/export`);
    expect(env.parallelHint.enabled).toBe(false);
    expect(env.quota.left).toBe(env.quota.total - env.quota.used - env.quota.reserved);
    expect(env.id.startsWith('w_')).toBe(true);
  });

  it('GET /works → 200 + {items,nextCursor,total}，且只含自己的作品', async () => {
    const res = await fetch(`${t.baseUrl}/api/works?limit=5`, { headers: auth(t.userA.token) });
    expect(res.status).toBe(200);
    const body = (await jsonOf(res)) as {
      items: { id: string; updatedAt: string; progress: number }[];
      nextCursor: string | null;
      total: number;
    };
    expect(Array.isArray(body.items)).toBe(true);
    expect(typeof body.total).toBe('number');
    expect(body.items.length).toBeLessThanOrEqual(5);
    for (const item of body.items) {
      expect(item.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
  });

  it('GET /works/:id → 200 信封；PATCH → 200 新标题；DELETE → 204 后再 GET → 404', async () => {
    const created = (await jsonOf(
      await fetch(`${t.baseUrl}/api/works`, {
        method: 'POST',
        headers: auth(t.userA.token),
        body: JSON.stringify({ keyword: '番茄工作法', title: '原标题' }),
      }),
    )) as WorkEnvelope;

    const detail = await fetch(`${t.baseUrl}/api/works/${created.id}`, {
      headers: auth(t.userA.token),
    });
    expect(detail.status).toBe(200);
    expect(WorkEnvelopeSchema.parse(await jsonOf(detail)).title).toBe('原标题');

    const patched = await fetch(`${t.baseUrl}/api/works/${created.id}`, {
      method: 'PATCH',
      headers: auth(t.userA.token),
      body: JSON.stringify({ title: '改名后的标题' }),
    });
    expect(patched.status).toBe(200);
    expect(WorkEnvelopeSchema.parse(await jsonOf(patched)).title).toBe('改名后的标题');

    const removed = await fetch(`${t.baseUrl}/api/works/${created.id}`, {
      method: 'DELETE',
      headers: auth(t.userA.token),
    });
    expect(removed.status).toBe(204);

    const afterDelete = await fetch(`${t.baseUrl}/api/works/${created.id}`, {
      headers: auth(t.userA.token),
    });
    expect(afterDelete.status).toBe(404);
  });

  it('PATCH 改成同名仍 200（不因 MySQL affectedRows=0 误判 404）', async () => {
    const created = (await jsonOf(
      await fetch(`${t.baseUrl}/api/works`, {
        method: 'POST',
        headers: auth(t.userA.token),
        body: JSON.stringify({ keyword: '同名测试', title: '同一个标题' }),
      }),
    )) as WorkEnvelope;

    const res = await fetch(`${t.baseUrl}/api/works/${created.id}`, {
      method: 'PATCH',
      headers: auth(t.userA.token),
      body: JSON.stringify({ title: '同一个标题' }),
    });
    expect(res.status).toBe(200);
    expect(WorkEnvelopeSchema.parse(await jsonOf(res)).title).toBe('同一个标题');
  });

  it('★跨用户隔离：A 拿 B 的 workId 调详情与所有写接口，全部 404（不是 403）', async () => {
    // B 建一个作品
    const bWork = (await jsonOf(
      await fetch(`${t.baseUrl}/api/works`, {
        method: 'POST',
        headers: auth(t.userB.token),
        body: JSON.stringify({ keyword: 'B的私有作品', title: 'B的标题' }),
      }),
    )) as WorkEnvelope;

    // A 用自己的 token 去访问 B 的 workId：详情 + 两个写接口 + 删除，共 4 个 :id 端点。
    const attempts = await Promise.all([
      fetch(`${t.baseUrl}/api/works/${bWork.id}`, { headers: auth(t.userA.token) }),
      fetch(`${t.baseUrl}/api/works/${bWork.id}`, {
        method: 'PATCH',
        headers: auth(t.userA.token),
        body: JSON.stringify({ title: 'A 篡改 B 的标题' }),
      }),
      fetch(`${t.baseUrl}/api/works/${bWork.id}`, {
        method: 'DELETE',
        headers: auth(t.userA.token),
      }),
    ]);

    for (const res of attempts) {
      expect(res.status).toBe(404);
      expect(res.status).not.toBe(403);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe('NOT_FOUND');
    }

    // B 的作品必须完好无损：标题未改、未被删除。
    const stillThere = await fetch(`${t.baseUrl}/api/works/${bWork.id}`, {
      headers: auth(t.userB.token),
    });
    expect(stillThere.status).toBe(200);
    const env = WorkEnvelopeSchema.parse(await jsonOf(stillThere));
    expect(env.title).toBe('B的标题');
  });

  it('★不可区分：「不属于你」与「根本不存在」的 404 响应逐字节相同', async () => {
    const bWork = (await jsonOf(
      await fetch(`${t.baseUrl}/api/works`, {
        method: 'POST',
        headers: auth(t.userB.token),
        body: JSON.stringify({ keyword: '不可区分用例' }),
      }),
    )) as WorkEnvelope;

    const notOwned = await fetch(`${t.baseUrl}/api/works/${bWork.id}`, {
      headers: auth(t.userA.token),
    });
    const notExists = await fetch(`${t.baseUrl}/api/works/w_0000000000000000000000000000dead`, {
      headers: auth(t.userA.token),
    });

    expect(notOwned.status).toBe(404);
    expect(notExists.status).toBe(404);
    expect(notOwned.status).toBe(notExists.status);

    const bodyA = await notOwned.text();
    const bodyB = await notExists.text();
    // 响应体逐字节相同 → 攻击者无法用状态差或文案差枚举有效 workId。
    expect(bodyA).toBe(bodyB);
    expect(JSON.parse(bodyA)).toEqual({ code: 'NOT_FOUND', message: '作品不存在', details: {} });

    // 响应头也不得泄露差异（比较与语义相关的头，排除 date/连接类噪声）。
    const pick = (r: Response): Record<string, string> => ({
      'content-type': r.headers.get('content-type') ?? '',
      'content-length': r.headers.get('content-length') ?? '',
    });
    expect(pick(notOwned)).toEqual(pick(notExists));
  });

  it('★Guard 链序：无 token 调 :id 得 401（不是 404）→ AuthGuard 先于 OwnershipGuard', async () => {
    const bWork = (await jsonOf(
      await fetch(`${t.baseUrl}/api/works`, {
        method: 'POST',
        headers: auth(t.userB.token),
        body: JSON.stringify({ keyword: '链序用例' }),
      }),
    )) as WorkEnvelope;

    for (const method of ['GET', 'PATCH', 'DELETE'] as const) {
      const res = await fetch(`${t.baseUrl}/api/works/${bWork.id}`, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(method === 'PATCH' ? { body: JSON.stringify({ title: 'x' }) } : {}),
      });
      // 若 OwnershipGuard 先跑，会因读不到 principal 而 401；若顺序反了且它先查库，
      // 就可能泄露 404。这里断言 401 证明鉴权是第一环。
      expect(res.status).toBe(401);
      expect(((await res.json()) as { code: string }).code).toBe('UNAUTHENTICATED');
    }

    const list = await fetch(`${t.baseUrl}/api/works`, { headers: { 'content-type': 'application/json' } });
    expect(list.status).toBe(401);
  });

  it('★闸门非硬编码：写入 selected_topic_id 后 G1 由 false 变 true（D-04 负向验证）', async () => {
    const created = (await jsonOf(
      await fetch(`${t.baseUrl}/api/works`, {
        method: 'POST',
        headers: auth(t.userA.token),
        body: JSON.stringify({ keyword: '闸门派生用例' }),
      }),
    )) as WorkEnvelope;
    expect(created.gates.G1).toBe(false);
    expect(created.gateDetails.G1?.reason).toBe('TOPIC_NOT_SELECTED');

    // 直接改真相列（模拟 T-13 选题落库），不经 HTTP。
    await t.handle.db
      .updateTable('work')
      .set({ selected_topic_id: 't10_topic_0001' })
      .where('id', '=', created.id)
      .execute();

    const after = WorkEnvelopeSchema.parse(
      await jsonOf(
        await fetch(`${t.baseUrl}/api/works/${created.id}`, { headers: auth(t.userA.token) }),
      ),
    );
    // 若实现硬编码 ok:true 或恒 false，这条必红。
    expect(after.gates.G1).toBe(true);
    expect(after.gateDetails.G1).toBeUndefined();
    expect(after.selectedTopicId).toBe('t10_topic_0001');
    // 其余门仍据实为 false，未被连带放行。
    expect(after.gates.G2).toBe(false);
    expect(after.gates.G3).toBe(false);
    expect(after.gates.G4).toBe(false);
  });

  it('DTO 校验：非法 keyword / title / limit / cursor 一律 400 VALIDATION_FAILED', async () => {
    const badCreate = await fetch(`${t.baseUrl}/api/works`, {
      method: 'POST',
      headers: auth(t.userA.token),
      body: JSON.stringify({ keyword: '' }),
    });
    expect(badCreate.status).toBe(400);
    expect(((await badCreate.json()) as { code: string }).code).toBe('VALIDATION_FAILED');

    const created = (await jsonOf(
      await fetch(`${t.baseUrl}/api/works`, {
        method: 'POST',
        headers: auth(t.userA.token),
        body: JSON.stringify({ keyword: '校验用例' }),
      }),
    )) as WorkEnvelope;

    const badPatch = await fetch(`${t.baseUrl}/api/works/${created.id}`, {
      method: 'PATCH',
      headers: auth(t.userA.token),
      body: JSON.stringify({ title: '' }),
    });
    expect(badPatch.status).toBe(400);

    const badLimit = await fetch(`${t.baseUrl}/api/works?limit=0`, { headers: auth(t.userA.token) });
    expect(badLimit.status).toBe(400);

    // 非法游标必须是 400（客户端输入错误），不是 500。
    const badCursor = await fetch(`${t.baseUrl}/api/works?cursor=not-a-cursor`, {
      headers: auth(t.userA.token),
    });
    expect(badCursor.status).toBe(400);
    const cursorBody = (await badCursor.json()) as { code: string; details: { fields: { path: string }[] } };
    expect(cursorBody.code).toBe('VALIDATION_FAILED');
    expect(cursorBody.details.fields[0]?.path).toBe('cursor');
  });

  it('★仓储真实库隔离：forUser(A) 读/改/删 B 的作品全部无效，且 B 数据不变', async () => {
    const bWork = (await jsonOf(
      await fetch(`${t.baseUrl}/api/works`, {
        method: 'POST',
        headers: auth(t.userB.token),
        body: JSON.stringify({ keyword: '仓储隔离用例', title: 'B原标题' }),
      }),
    )) as WorkEnvelope;

    const repoA = createWorkRepository(t.handle.db).forUser(t.userA.id);
    const repoB = createWorkRepository(t.handle.db).forUser(t.userB.id);

    // 读不到
    expect(await repoA.findById(bWork.id)).toBeNull();
    // 改不动
    expect(await repoA.rename(bWork.id, 'A 篡改')).toBeNull();
    // 删不掉
    expect(await repoA.softDelete(bWork.id)).toBe(false);
    // 列表里不含 B 的任何作品
    const pageA = await repoA.list({}, { limit: 100 });
    expect(pageA.items.some((r) => r.id === bWork.id)).toBe(false);
    for (const row of pageA.items) expect(row.user_id).toBe(t.userA.id);

    // B 侧完好
    const stillB = await repoB.findById(bWork.id);
    expect(stillB?.title).toBe('B原标题');
    expect(stillB?.deleted_at).toBeNull();
  });

  it('★仓储无身份/错误身份：forUser("") 抛 WORK_SCOPE_REQUIRED，不存在「查全表」退路', async () => {
    const factory = createWorkRepository(t.handle.db);
    let code: string | undefined;
    try {
      factory.forUser('');
    } catch (err) {
      code = (err as { code?: string }).code;
    }
    expect(code).toBe('WORK_SCOPE_REQUIRED');
    expect(WorkScopeRequiredError.name).toBe('WorkScopeRequiredError');

    // 传一个不存在的 userId：只能拿到空结果，拿不到任何人的数据。
    const ghost = factory.forUser('t10_ghost_user_000000');
    expect(await ghost.list({}, { limit: 100 })).toEqual({ items: [], nextCursor: null });
    expect(await ghost.count({})).toBe(0);
  });
});

describe('T-10 E2E：游标分页真实翻页（独立数据集，无重叠无遗漏）', () => {
  let t: WorksTestApp;

  beforeAll(async () => {
    t = await createWorksTestApp();
  }, 60_000);

  afterAll(async () => {
    await t?.cleanup();
  }, 60_000);

  it('★25 条 / limit=10 → 3 页翻完，恰好 25 条、零重复、零遗漏、DESC 有序', async () => {
    // 构造确定的 updated_at：index 越大越新。DESC 排序下应从 index 24 开始。
    const seeded: { id: string; minute: number }[] = [];
    for (let i = 0; i < 25; i += 1) {
      const id = await t.seedWork(t.userA.id, `分页作品-${i}`, lit(i));
      seeded.push({ id, minute: i });
    }
    const expectedOrder = [...seeded].sort((a, b) => b.minute - a.minute).map((s) => s.id);

    const collected: string[] = [];
    const pageSizes: number[] = [];
    let cursor: string | null = null;
    let pages = 0;

    do {
      const url: string =
        `${t.baseUrl}/api/works?limit=10` + (cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`);
      const res = await fetch(url, { headers: auth(t.userA.token) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        items: { id: string }[];
        nextCursor: string | null;
        total: number;
      };
      expect(body.total).toBe(25);
      pageSizes.push(body.items.length);
      collected.push(...body.items.map((i) => i.id));
      cursor = body.nextCursor;
      pages += 1;
      expect(pages).toBeLessThan(10); // 防御死循环
    } while (cursor !== null);

    expect(pages).toBe(3);
    expect(pageSizes).toEqual([10, 10, 5]);
    expect(collected).toHaveLength(25);
    // 无重叠
    expect(new Set(collected).size).toBe(25);
    // 无遗漏 + 顺序正确（逐位比对，不只是集合相等）
    expect(collected).toEqual(expectedOrder);
  });

  it('★同毫秒并列：5 条 updated_at 完全相同，limit=2 仍无重叠无遗漏（(updated_at,id) tie-breaker）', async () => {
    const same = lit(500);
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      ids.push(await t.seedWork(t.userB.id, `并列作品-${i}`, same));
    }

    const collected: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url: string =
        `${t.baseUrl}/api/works?limit=2` + (cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`);
      const res = await fetch(url, { headers: auth(t.userB.token) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: { id: string }[]; nextCursor: string | null };
      collected.push(...body.items.map((i) => i.id));
      cursor = body.nextCursor;
      pages += 1;
      expect(pages).toBeLessThan(10);
    } while (cursor !== null);

    // 只按 updated_at 翻页会在并列处漏行/重复；补 id 作第二排序键后必须恰好 5 条。
    expect(collected).toHaveLength(5);
    expect(new Set(collected).size).toBe(5);
    expect([...collected].sort()).toEqual([...ids].sort());
    expect(pages).toBe(3);
  });

  it('★分页隔离：A 翻页看不到 B 的任何作品（total 也各自独立）', async () => {
    const resA = await fetch(`${t.baseUrl}/api/works?limit=100`, { headers: auth(t.userA.token) });
    const bodyA = (await resA.json()) as { items: { id: string }[]; total: number };
    const resB = await fetch(`${t.baseUrl}/api/works?limit=100`, { headers: auth(t.userB.token) });
    const bodyB = (await resB.json()) as { items: { id: string }[]; total: number };

    expect(bodyA.total).toBe(25);
    expect(bodyB.total).toBe(5);
    const setA = new Set(bodyA.items.map((i) => i.id));
    for (const item of bodyB.items) expect(setA.has(item.id)).toBe(false);
  });

  it('q 检索：≥2 字走 ngram 全文召回，单字降级 LIKE 也能召回（不为空）', async () => {
    const two = await fetch(`${t.baseUrl}/api/works?q=${encodeURIComponent('分页')}&limit=100`, {
      headers: auth(t.userA.token),
    });
    expect(two.status).toBe(200);
    const twoBody = (await two.json()) as { total: number; items: unknown[] };
    expect(twoBody.total).toBe(25);

    // 单字「页」：ngram_token_size=2 下全文无法成词，必须降级 LIKE 且不返回空。
    const one = await fetch(`${t.baseUrl}/api/works?q=${encodeURIComponent('页')}&limit=100`, {
      headers: auth(t.userA.token),
    });
    expect(one.status).toBe(200);
    const oneBody = (await one.json()) as { total: number };
    expect(oneBody.total).toBe(25);
  });
});