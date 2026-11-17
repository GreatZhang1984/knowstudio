/**
 * T-36 SearchSession 仓储 · 真实 MySQL 8.4 集成测试。
 *
 * ## 为什么每个用例跑在「一律回滚」的真实事务里
 * vitest 默认**并行跑文件**，而 mysql-integration.test.ts 的 DoD③ 断言的是**全局**种子计数
 * （`COUNT(*) FROM material = 10`、`work_material = 2` 等）。若本文件提交测试行，会污染那些计数
 * 导致整套门禁随机翻红。故每个用例独享一个真实事务，结束一律 ROLLBACK：
 *   - 真实 MySQL 语义全部生效：FK / CHECK / STORED 生成列 keyword_hash / JSON 列读写 / DATETIME 比较；
 *   - 但**绝不留下已提交行**，对并行文件零污染，也不触碰种子数据。
 * 这是比「提交后 DELETE 清理」更强的隔离（清理窗口期内仍可能被并行文件读到）。
 *
 * 连接口径与 mysql-integration 一致：createDb() → assertServerCapabilities()。
 * 库已迁移 + 播种（任务前置），本文件自带 t36_ss_ 前缀的确定性 fixture，不依赖种子行。
 * 错误判定一律用结构化 code，不解析 message。
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import type { JobStatus } from '@knowstudio/contracts';
import { assertServerCapabilities, createDb, type DbHandle } from '../src/client.js';
import type { Database } from '../src/schema/index.js';
import { toJsonParam } from '../src/schema/column-types.js';
import {
  createSearchSessionRepository,
  SearchSessionIdInvalidError,
  SearchSessionScopeRequiredError,
  type SearchSessionResults,
} from '../src/repositories/index.js';

let handle: DbHandle;
let db: Kysely<Database>;

beforeAll(async () => {
  handle = createDb();
  db = handle.db;
  await assertServerCapabilities(db);
}, 60_000);

afterAll(async () => {
  await handle?.destroy();
}, 60_000);

/** 哨兵错误：只为强制事务回滚，不是失败。 */
class Rollback extends Error {
  readonly code = 'T36_ROLLBACK';
}

/** 每个用例独享一个真实事务，结束一律回滚（见文件头）。 */
async function inTx(fn: (t: Kysely<Database>) => Promise<void>): Promise<void> {
  await db
    .transaction()
    .execute(async (t) => {
      await fn(t);
      throw new Rollback();
    })
    .catch((err: unknown) => {
      if (!(err instanceof Rollback)) throw err;
    });
}

/** DATETIME(3) UTC 字面量（与 seed.utcLiteral / 仓储 toUtcLiteral 同口径）。 */
function lit(d: Date): string {
  return d.toISOString().replace('T', ' ').replace('Z', '');
}

const UA = 't36_ss_user_a';
const UB = 't36_ss_user_b';
const WA = 't36_ss_work_a';
const WB = 't36_ss_work_b';
const UTC_LITERAL = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/;

async function setupUsers(t: Kysely<Database>): Promise<void> {
  await t
    .insertInto('app_user')
    .values([
      { id: UA, name: 'T36 SS A', email: 't36_ss_a@test.local' },
      { id: UB, name: 'T36 SS B', email: 't36_ss_b@test.local' },
    ])
    .execute();
  await t
    .insertInto('work')
    .values([
      { id: WA, user_id: UA, title: 'T36 SS Work A' },
      { id: WB, user_id: UB, title: 'T36 SS Work B' },
    ])
    .execute();
}

/** 直插会话（可控 created_at / status），供缓存窗口与排序用例使用。 */
async function insertSession(
  t: Kysely<Database>,
  o: {
    id: string;
    workId: string;
    userId: string;
    keyword: string;
    domain: string | null;
    status: JobStatus;
    createdAt: string;
  },
): Promise<void> {
  await t
    .insertInto('search_session')
    .values({
      id: o.id,
      work_id: o.workId,
      user_id: o.userId,
      keyword: o.keyword,
      domain: o.domain,
      status: o.status,
      created_at: o.createdAt,
      saturation: null,
      blank_angles: toJsonParam([]),
      material_ids: toJsonParam([]),
      partial_errors: toJsonParam([]),
      duration_ms: null,
      cache_hit: 0,
    })
    .execute();
}

const RESULTS: SearchSessionResults = {
  status: 'succeeded',
  saturation: {
    score: 72,
    level: 'saturated',
    confidence: 0.8,
    sampleSize: 40,
    coveredPlatforms: ['douyin', 'bili'],
    sources: ['zhihu', 'weibo'],
    sufficient: true,
  },
  blankAngles: [
    { id: 'ba_t36_1', label: '反常识切入', basisMaterialIds: ['mat_t36_1'], rationale: '样本缺口' },
  ],
  materialIds: ['mat_t36_1', 'mat_t36_2'],
  partialErrors: [{ source: 'zhihu', code: 'E_TIMEOUT', message: '单源超时' }],
  durationMs: 1234,
  cacheHit: true,
};

describe('T-36 SearchSession · insert 默认值与生成列', () => {
  it('status=queued / cache_hit=0 / 空 JSON 数组 / saturation=null；keyword_hash=MD5(keyword)；user_id 取自作用域', () =>
    inTx(async (t) => {
      await setupUsers(t);
      const repo = createSearchSessionRepository(t).forUser(UA);
      // 即使入参塞 user_id 也不得生效（CreateSearchSessionInput 无该字段，运行时被忽略）。
      const row = await repo.insert({
        id: 't36_ss_s1',
        workId: WA,
        keyword: '费曼学习法',
        domain: null,
        ...({ user_id: UB } as object),
      });
      expect(row.user_id).toBe(UA);
      expect(row.work_id).toBe(WA);
      expect(row.status).toBe('queued');
      expect(row.cache_hit).toBe(0);
      expect(row.saturation).toBeNull();
      expect(row.blank_angles).toEqual([]);
      expect(row.material_ids).toEqual([]);
      expect(row.partial_errors).toEqual([]);
      expect(row.duration_ms).toBeNull();
      expect(row.created_at).toMatch(UTC_LITERAL);
      // STORED 生成列由 DB 计算，等于 MD5(keyword)（utf8mb4 与 JS utf8 同字节）。
      expect(row.keyword_hash).toBe(createHash('md5').update('费曼学习法', 'utf8').digest('hex'));
    }));

  it('domain 省略时落 NULL；非法 id 抛 SEARCH_SESSION_ID_INVALID（不落 SQL）', () =>
    inTx(async (t) => {
      await setupUsers(t);
      const repo = createSearchSessionRepository(t).forUser(UA);
      const row = await repo.insert({ id: 't36_ss_s2', workId: WA, keyword: 'k' });
      expect(row.domain).toBeNull();
      await expect(repo.insert({ id: 'bad id!', workId: WA, keyword: 'k' })).rejects.toMatchObject({
        code: 'SEARCH_SESSION_ID_INVALID',
      });
      await expect(repo.findById('bad id!')).rejects.toBeInstanceOf(SearchSessionIdInvalidError);
    }));
});

describe('T-36 SearchSession · findById 用户隔离', () => {
  it('A 读不到 B 的会话；各自能读自己的', () =>
    inTx(async (t) => {
      await setupUsers(t);
      const a = createSearchSessionRepository(t).forUser(UA);
      const b = createSearchSessionRepository(t).forUser(UB);
      await a.insert({ id: 't36_ss_a1', workId: WA, keyword: 'ka' });
      await b.insert({ id: 't36_ss_b1', workId: WB, keyword: 'kb' });
      expect(await a.findById('t36_ss_b1')).toBeNull();
      expect(await b.findById('t36_ss_a1')).toBeNull();
      expect((await a.findById('t36_ss_a1'))?.id).toBe('t36_ss_a1');
      expect((await b.findById('t36_ss_b1'))?.id).toBe('t36_ss_b1');
    }));
});

describe('T-36 SearchSession · updateResults JSON 往返', () => {
  it('saturation/blankAngles/materialIds/partialErrors 如实往返；status/duration/cache_hit 落库', () =>
    inTx(async (t) => {
      await setupUsers(t);
      const repo = createSearchSessionRepository(t).forUser(UA);
      await repo.insert({ id: 't36_ss_r1', workId: WA, keyword: 'k' });
      const updated = await repo.updateResults('t36_ss_r1', RESULTS);
      expect(updated).not.toBeNull();
      expect(updated?.status).toBe('succeeded');
      expect(updated?.cache_hit).toBe(1);
      expect(updated?.duration_ms).toBe(1234);
      // mysql2 已把 JSON 列解析成对象，故可直接深比对（不再二次 parse）。
      expect(updated?.saturation).toEqual(RESULTS.saturation);
      expect(updated?.blank_angles).toEqual(RESULTS.blankAngles);
      expect(updated?.material_ids).toEqual(RESULTS.materialIds);
      expect(updated?.partial_errors).toEqual(RESULTS.partialErrors);
      // 再读一次证明真的落库（不是回显入参）。
      const reread = await repo.findById('t36_ss_r1');
      expect(reread?.saturation).toEqual(RESULTS.saturation);
      expect(reread?.blank_angles).toEqual(RESULTS.blankAngles);
    }));

  it('saturation=null 往返；重复写相同结果仍返回行（不靠 affectedRows）', () =>
    inTx(async (t) => {
      await setupUsers(t);
      const repo = createSearchSessionRepository(t).forUser(UA);
      await repo.insert({ id: 't36_ss_r2', workId: WA, keyword: 'k' });
      const nullSat: SearchSessionResults = { ...RESULTS, saturation: null, cacheHit: false };
      const first = await repo.updateResults('t36_ss_r2', nullSat);
      expect(first?.saturation).toBeNull();
      expect(first?.cache_hit).toBe(0);
      // 再写一遍完全相同的结果：changedRows 可能为 0，但必须仍返回行而非 null。
      const again = await repo.updateResults('t36_ss_r2', nullSat);
      expect(again).not.toBeNull();
      expect(again?.id).toBe('t36_ss_r2');
    }));

  it('跨用户：A 改 B 的会话 → null，且 B 的行未被改动', () =>
    inTx(async (t) => {
      await setupUsers(t);
      const a = createSearchSessionRepository(t).forUser(UA);
      const b = createSearchSessionRepository(t).forUser(UB);
      await b.insert({ id: 't36_ss_b2', workId: WB, keyword: 'kb' });
      expect(await a.updateResults('t36_ss_b2', RESULTS)).toBeNull();
      const untouched = await b.findById('t36_ss_b2');
      expect(untouched?.status).toBe('queued');
      expect(untouched?.saturation).toBeNull();
    }));
});

describe('T-36 SearchSession · findCached 缓存命中口径', () => {
  // 固定基准时刻，避免依赖客户端/服务端时钟差。
  const base = new Date('2026-11-13T12:00:00.000Z');
  const sinceRecent = new Date(base.getTime() - 3_600_000); // base-1h

  it('null-safe domain：NULL 命中 NULL，不命中非 NULL；非 NULL 同理', () =>
    inTx(async (t) => {
      await setupUsers(t);
      const repo = createSearchSessionRepository(t).forUser(UA);
      await insertSession(t, { id: 't36_ss_c1', workId: WA, userId: UA, keyword: 't36ss缓存', domain: null, status: 'succeeded', createdAt: lit(base) });
      await insertSession(t, { id: 't36_ss_c2', workId: WA, userId: UA, keyword: 't36ss缓存2', domain: 'edu', status: 'succeeded', createdAt: lit(base) });
      expect((await repo.findCached('t36ss缓存', null, sinceRecent))?.id).toBe('t36_ss_c1');
      expect(await repo.findCached('t36ss缓存', 'edu', sinceRecent)).toBeNull();
      expect((await repo.findCached('t36ss缓存2', 'edu', sinceRecent))?.id).toBe('t36_ss_c2');
      expect(await repo.findCached('t36ss缓存2', null, sinceRecent)).toBeNull();
    }));

  it('仅 succeeded：queued / failed 都不命中', () =>
    inTx(async (t) => {
      await setupUsers(t);
      const repo = createSearchSessionRepository(t).forUser(UA);
      await insertSession(t, { id: 't36_ss_q', workId: WA, userId: UA, keyword: 't36ss队列', domain: null, status: 'queued', createdAt: lit(base) });
      await insertSession(t, { id: 't36_ss_f', workId: WA, userId: UA, keyword: 't36ss失败', domain: null, status: 'failed', createdAt: lit(base) });
      expect(await repo.findCached('t36ss队列', null, sinceRecent)).toBeNull();
      expect(await repo.findCached('t36ss失败', null, sinceRecent)).toBeNull();
    }));

  it('24h 窗口：created_at < since 不命中；放宽 since 后命中', () =>
    inTx(async (t) => {
      await setupUsers(t);
      const repo = createSearchSessionRepository(t).forUser(UA);
      const old = new Date(base.getTime() - 25 * 3_600_000); // base-25h
      await insertSession(t, { id: 't36_ss_old', workId: WA, userId: UA, keyword: 't36ss旧', domain: null, status: 'succeeded', createdAt: lit(old) });
      const since24 = new Date(base.getTime() - 24 * 3_600_000);
      expect(await repo.findCached('t36ss旧', null, since24)).toBeNull();
      const since26 = new Date(base.getTime() - 26 * 3_600_000);
      expect((await repo.findCached('t36ss旧', null, since26))?.id).toBe('t36_ss_old');
    }));

  it('取最近一条；同毫秒并列按 id DESC tie-break', () =>
    inTx(async (t) => {
      await setupUsers(t);
      const repo = createSearchSessionRepository(t).forUser(UA);
      const older = new Date(base.getTime() - 60_000);
      await insertSession(t, { id: 't36_ss_n1', workId: WA, userId: UA, keyword: 't36ss新', domain: null, status: 'succeeded', createdAt: lit(older) });
      await insertSession(t, { id: 't36_ss_n2', workId: WA, userId: UA, keyword: 't36ss新', domain: null, status: 'succeeded', createdAt: lit(base) });
      expect((await repo.findCached('t36ss新', null, sinceRecent))?.id).toBe('t36_ss_n2');
      // 同 created_at，id 较大者胜（id DESC）。
      await insertSession(t, { id: 't36_ss_t1', workId: WA, userId: UA, keyword: 't36ss并列', domain: null, status: 'succeeded', createdAt: lit(base) });
      await insertSession(t, { id: 't36_ss_t2', workId: WA, userId: UA, keyword: 't36ss并列', domain: null, status: 'succeeded', createdAt: lit(base) });
      expect((await repo.findCached('t36ss并列', null, sinceRecent))?.id).toBe('t36_ss_t2');
    }));

  it('跨用户隔离：B 的 succeeded 会话不被 A 命中', () =>
    inTx(async (t) => {
      await setupUsers(t);
      const a = createSearchSessionRepository(t).forUser(UA);
      await insertSession(t, { id: 't36_ss_bc', workId: WB, userId: UB, keyword: 't36ss共享', domain: null, status: 'succeeded', createdAt: lit(base) });
      expect(await a.findCached('t36ss共享', null, sinceRecent)).toBeNull();
    }));
});

describe('T-36 SearchSession · 作用域与非法身份', () => {
  it.each(['', '   ', 'x'.repeat(37)])('forUser(%j) 抛 SEARCH_SESSION_SCOPE_REQUIRED', (bad) => {
    expect(() => createSearchSessionRepository(db).forUser(bad)).toThrowError(SearchSessionScopeRequiredError);
    let code: string | undefined;
    try {
      createSearchSessionRepository(db).forUser(bad);
    } catch (err) {
      code = (err as { code?: string }).code;
    }
    expect(code).toBe('SEARCH_SESSION_SCOPE_REQUIRED');
  });
});