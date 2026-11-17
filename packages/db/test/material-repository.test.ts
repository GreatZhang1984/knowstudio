/**
 * T-36 Material 素材库仓储 · 真实 MySQL 8.4 集成测试。
 *
 * 事务回滚口径与 search-session-repository.test.ts 完全一致（见该文件头）：
 * 每用例独享真实事务、结束一律 ROLLBACK，真实 MySQL 语义全生效但对并行文件零污染
 * （尤其不污染 mysql-integration 的全局 `COUNT(*) FROM material = 10`）。
 *
 * 覆盖：可见性（全局 NULL + 本人私有，排除他人私有/软删）、findByIds 空入参与确定性排序、
 * q/type/license 过滤、LIKE 元字符转义、list 与 count 同口径、keyset 游标无重叠无遗漏 + 同毫秒 tie-break。
 * 所有 fixture 标题含独特 token `t36mat`，与种子素材区分，便于闭集断言。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import type { LicenseState, MaterialType } from '@knowstudio/contracts';
import { assertServerCapabilities, createDb, type DbHandle } from '../src/client.js';
import type { Database } from '../src/schema/index.js';
import { toJsonParam } from '../src/schema/column-types.js';
import {
  createMaterialRepository,
  MaterialCursorInvalidError,
  MaterialIdInvalidError,
  MaterialScopeRequiredError,
  type LibraryFilter,
  type MaterialRow,
  type ScopedMaterialRepository,
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

class Rollback extends Error {
  readonly code = 'T36_ROLLBACK';
}

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

function lit(d: Date): string {
  return d.toISOString().replace('T', ' ').replace('Z', '');
}

const UA = 't36_mat_user_a';
const UB = 't36_mat_user_b';
const base = new Date('2026-11-13T00:00:00.000Z');
const at = (min: number): string => lit(new Date(base.getTime() + min * 60_000));

interface MatSpec {
  id: string;
  userId: string | null;
  type: MaterialType;
  title: string;
  license?: LicenseState;
  createdAt?: string;
  deletedAt?: string | null;
}

async function insertMat(t: Kysely<Database>, m: MatSpec): Promise<void> {
  const license = m.license ?? 'unknown';
  await t
    .insertInto('material')
    .values({
      id: m.id,
      user_id: m.userId,
      type: m.type,
      title: m.title,
      // cleared 需凭证或 source=self（ck_material_evidence）；这里统一用 self 满足 CHECK。
      source: 'self',
      license,
      // tags 显式落 []：MySQL 8.4.13「JSON 默认值 + 多值索引 ix_material_tags」走默认值会报 3903（实测）。
      tags: toJsonParam([]),
      created_at: m.createdAt ?? at(0),
      deleted_at: m.deletedAt ?? null,
    })
    .execute();
}

async function setupUsers(t: Kysely<Database>): Promise<void> {
  await t
    .insertInto('app_user')
    .values([
      { id: UA, name: 'T36 MAT A', email: 't36_mat_a@test.local' },
      { id: UB, name: 'T36 MAT B', email: 't36_mat_b@test.local' },
    ])
    .execute();
}

/** 可见性 fixture：全局 3 + A 私有 2 + A 软删 1 + B 私有 2。 */
async function setupVisibility(t: Kysely<Database>): Promise<void> {
  await setupUsers(t);
  const mats: MatSpec[] = [
    { id: 't36_mat_g1', userId: null, type: 'knowledge', title: 't36mat 全局知识甲', license: 'cleared', createdAt: at(0) },
    { id: 't36_mat_g2', userId: null, type: 'hot', title: 't36mat 全局热点乙', createdAt: at(1) },
    { id: 't36_mat_g3', userId: null, type: 'image', title: 't36mat 全局图片丙', license: 'restricted', createdAt: at(2) },
    { id: 't36_mat_a1', userId: UA, type: 'doc', title: 't36mat 私有文档甲', license: 'cleared', createdAt: at(3) },
    { id: 't36_mat_a2', userId: UA, type: 'knowledge', title: 't36mat 私有知识乙', createdAt: at(4) },
    { id: 't36_mat_a3', userId: UA, type: 'knowledge', title: 't36mat 已删除', createdAt: at(5), deletedAt: at(6) },
    { id: 't36_mat_b1', userId: UB, type: 'knowledge', title: 't36mat B私有甲', createdAt: at(6) },
    { id: 't36_mat_b2', userId: UB, type: 'doc', title: 't36mat B私有乙', license: 'cleared', createdAt: at(7) },
  ];
  for (const m of mats) await insertMat(t, m);
}

const ids = (rows: readonly MaterialRow[]): string[] => rows.map((r) => r.id);

/** 翻页收集全部 id（带 runaway 保护），用于无重叠无遗漏断言。 */
async function collectAll(
  repo: ScopedMaterialRepository,
  filter: LibraryFilter,
  limit: number,
): Promise<{ ids: string[]; pages: number }> {
  const out: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await repo.listLibrary(filter, { limit, cursor });
    pages += 1;
    for (const r of page.items) out.push(r.id);
    cursor = page.nextCursor ?? undefined;
    if (pages > 100) throw new Error('分页 runaway');
  } while (cursor !== undefined);
  return { ids: out, pages };
}

describe('T-36 Material · findByIds 可见性与空入参', () => {
  it('空入参直接返回 []（不发 SQL）', () =>
    inTx(async (t) => {
      const repo = createMaterialRepository(t).forUser(UA);
      expect(await repo.findByIds([])).toEqual([]);
    }));

  it('A 只见全局 + 本人私有；排除 B 私有/软删/不存在；按 id 升序确定性排序', () =>
    inTx(async (t) => {
      await setupVisibility(t);
      const a = createMaterialRepository(t).forUser(UA);
      const b = createMaterialRepository(t).forUser(UB);
      const req = ['t36_mat_g1', 't36_mat_a1', 't36_mat_b1', 't36_mat_a3', 't36_mat_ghost'];
      expect(ids(await a.findByIds(req))).toEqual(['t36_mat_a1', 't36_mat_g1']);
      expect(ids(await b.findByIds(req))).toEqual(['t36_mat_b1', 't36_mat_g1']);
    }));

  it('非法 id 抛 MATERIAL_ID_INVALID', () =>
    inTx(async (t) => {
      const repo = createMaterialRepository(t).forUser(UA);
      await expect(repo.findByIds(['bad id!'])).rejects.toBeInstanceOf(MaterialIdInvalidError);
    }));
});

describe('T-36 Material · listLibrary 可见性', () => {
  it('A 的库 = 全局 + 本人私有，排除 B 私有与软删；count 与 items 同口径', () =>
    inTx(async (t) => {
      await setupVisibility(t);
      const a = createMaterialRepository(t).forUser(UA);
      const page = await a.listLibrary({ q: 't36mat' }, { limit: 50 });
      expect([...ids(page.items)].sort()).toEqual(
        ['t36_mat_a1', 't36_mat_a2', 't36_mat_g1', 't36_mat_g2', 't36_mat_g3'].sort(),
      );
      expect(page.nextCursor).toBeNull();
      expect(await a.countLibrary({ q: 't36mat' })).toBe(5);
    }));

  it('B 的库 = 全局 + B 私有，排除 A 私有', () =>
    inTx(async (t) => {
      await setupVisibility(t);
      const b = createMaterialRepository(t).forUser(UB);
      const page = await b.listLibrary({ q: 't36mat' }, { limit: 50 });
      expect([...ids(page.items)].sort()).toEqual(
        ['t36_mat_b1', 't36_mat_b2', 't36_mat_g1', 't36_mat_g2', 't36_mat_g3'].sort(),
      );
    }));

  it('无过滤全量：每行 user_id 必为本人或 NULL（绝不泄漏他人私有/种子用户私有）', () =>
    inTx(async (t) => {
      await setupVisibility(t);
      const a = createMaterialRepository(t).forUser(UA);
      const { ids: all } = await collectAll(a, {}, 5);
      const rows = await a.findByIds(all);
      for (const r of rows) expect(r.user_id === UA || r.user_id === null).toBe(true);
      // 种子全局素材（user_id NULL）可见，但 B 私有与软删绝不出现。
      expect(all).not.toContain('t36_mat_b1');
      expect(all).not.toContain('t36_mat_a3');
    }));
});

describe('T-36 Material · q/type/license 过滤 + list/count 同口径', () => {
  it('type / license / q 单独与组合过滤，countLibrary 恒等于翻页总数', () =>
    inTx(async (t) => {
      await setupVisibility(t);
      const a = createMaterialRepository(t).forUser(UA);
      const cases: { filter: LibraryFilter; expected: string[] }[] = [
        { filter: { q: 't36mat', type: 'knowledge' }, expected: ['t36_mat_a2', 't36_mat_g1'] },
        { filter: { q: 't36mat', license: 'cleared' }, expected: ['t36_mat_a1', 't36_mat_g1'] },
        { filter: { q: '知识' }, expected: ['t36_mat_a2', 't36_mat_g1'] },
        { filter: { q: 't36mat', type: 'knowledge', license: 'unknown' }, expected: ['t36_mat_a2'] },
        { filter: { q: 't36mat', type: 'doc' }, expected: ['t36_mat_a1'] },
      ];
      for (const c of cases) {
        const { ids: got } = await collectAll(a, c.filter, 2);
        expect([...got].sort(), JSON.stringify(c.filter)).toEqual([...c.expected].sort());
        expect(await a.countLibrary(c.filter), JSON.stringify(c.filter)).toBe(c.expected.length);
      }
    }));

  it('q 为空/纯空白时不加谓词（与无 q 等价）', () =>
    inTx(async (t) => {
      await setupVisibility(t);
      const a = createMaterialRepository(t).forUser(UA);
      const none = await a.countLibrary({ q: 't36mat' });
      expect(await a.countLibrary({ q: 't36mat', type: undefined })).toBe(none);
      const all = await a.countLibrary({});
      expect(await a.countLibrary({ q: '   ' })).toBe(all);
    }));
});

describe('T-36 Material · LIKE 元字符转义', () => {
  it('q 里的 % 与 _ 按字面量匹配，不当通配符', () =>
    inTx(async (t) => {
      await setupUsers(t);
      await insertMat(t, { id: 't36_mat_pct', userId: UA, type: 'doc', title: 't36mat 折扣50%off' });
      await insertMat(t, { id: 't36_mat_plain', userId: UA, type: 'doc', title: 't36mat 普通标题' });
      await insertMat(t, { id: 't36_mat_us', userId: UA, type: 'doc', title: 't36mat 下划_线' });
      await insertMat(t, { id: 't36_mat_usx', userId: UA, type: 'doc', title: 't36mat 下划X线' });
      const a = createMaterialRepository(t).forUser(UA);
      expect((await a.listLibrary({ q: '50%' }, { limit: 50 })).items.map((r) => r.id)).toEqual(['t36_mat_pct']);
      expect((await a.listLibrary({ q: '%' }, { limit: 50 })).items.map((r) => r.id)).toEqual(['t36_mat_pct']);
      expect((await a.listLibrary({ q: '下划_线' }, { limit: 50 })).items.map((r) => r.id)).toEqual(['t36_mat_us']);
    }));
});

describe('T-36 Material · keyset 游标分页', () => {
  it('7 条 limit=3：无重叠无遗漏，顺序 created_at DESC，末页 nextCursor=null', () =>
    inTx(async (t) => {
      await setupUsers(t);
      for (let n = 1; n <= 7; n += 1) {
        await insertMat(t, { id: `t36_mat_p${n}`, userId: UA, type: 'knowledge', title: `t36mat 分页${n}`, createdAt: at(n) });
      }
      const a = createMaterialRepository(t).forUser(UA);
      const { ids: got, pages } = await collectAll(a, { q: 't36mat' }, 3);
      expect(got).toEqual(['t36_mat_p7', 't36_mat_p6', 't36_mat_p5', 't36_mat_p4', 't36_mat_p3', 't36_mat_p2', 't36_mat_p1']);
      expect(new Set(got).size).toBe(got.length); // 无重叠
      expect(got.length).toBe(7); // 无遗漏
      expect(pages).toBe(3);
      expect(await a.countLibrary({ q: 't36mat' })).toBe(7);
      const last = await a.listLibrary({ q: 't36mat' }, { limit: 3, cursor: undefined });
      expect(last.nextCursor).not.toBeNull();
    }));

  it('同毫秒并列按 id DESC tie-break，跨页不重不漏', () =>
    inTx(async (t) => {
      await setupUsers(t);
      // 两条 created_at 完全相同，id ta < tb → DESC 应为 tb, ta。
      await insertMat(t, { id: 't36_mat_ta', userId: UA, type: 'knowledge', title: 't36mat 并列A', createdAt: at(10) });
      await insertMat(t, { id: 't36_mat_tb', userId: UA, type: 'knowledge', title: 't36mat 并列B', createdAt: at(10) });
      const a = createMaterialRepository(t).forUser(UA);
      const { ids: got } = await collectAll(a, { q: 't36mat' }, 1);
      expect(got).toEqual(['t36_mat_tb', 't36_mat_ta']);
      expect(new Set(got).size).toBe(2);
    }));

  it('非法游标抛 MATERIAL_CURSOR_INVALID', () =>
    inTx(async (t) => {
      const a = createMaterialRepository(t).forUser(UA);
      await expect(a.listLibrary({}, { limit: 5, cursor: 'not-a-cursor' })).rejects.toBeInstanceOf(MaterialCursorInvalidError);
    }));
});

describe('T-36 Material · 作用域与非法身份', () => {
  it.each(['', '   ', 'x'.repeat(37)])('forUser(%j) 抛 MATERIAL_SCOPE_REQUIRED', (bad) => {
    expect(() => createMaterialRepository(db).forUser(bad)).toThrowError(MaterialScopeRequiredError);
  });
});