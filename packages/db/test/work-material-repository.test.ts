/**
 * T-36 WorkMaterial 收藏仓储 · 真实 MySQL 8.4 集成测试。
 *
 * 事务回滚口径与 search-session-repository.test.ts 完全一致（见该文件头）：
 * 每用例独享真实事务、结束一律 ROLLBACK，真实 MySQL 语义（FK / 主键冲突 / ON DUP / JSON）全生效，
 * 但对并行文件零污染（尤其不污染 mysql-integration 的全局 `COUNT(*) FROM work_material = 2`）。
 *
 * 覆盖：collect 幂等、纵深防御（work 非本人 / material 不可见 → 结构化 code，且不写库）、
 * uncollect  absent→false 与跨用户隔离、count/list 按 work_id+user_id 双重谓词、re-collect 保留 used_in。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { assertServerCapabilities, createDb, type DbHandle } from '../src/client.js';
import type { Database } from '../src/schema/index.js';
import { toJsonParam } from '../src/schema/column-types.js';
import {
  createWorkMaterialRepository,
  MaterialNotVisibleError,
  WorkMaterialIdInvalidError,
  WorkMaterialScopeRequiredError,
  WorkNotOwnedError,
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

const UA = 't36_wm_user_a';
const UB = 't36_wm_user_b';
const WA = 't36_wm_work_a';
const WB = 't36_wm_work_b';
const WAD = 't36_wm_work_a_del';
const G = 't36_wm_g1';
const MA = 't36_wm_a1';
const MB = 't36_wm_b1';
const MAD = 't36_wm_a_del';
const base = new Date('2026-11-13T00:00:00.000Z');

async function setup(t: Kysely<Database>): Promise<void> {
  await t
    .insertInto('app_user')
    .values([
      { id: UA, name: 'T36 WM A', email: 't36_wm_a@test.local' },
      { id: UB, name: 'T36 WM B', email: 't36_wm_b@test.local' },
    ])
    .execute();
  await t
    .insertInto('work')
    .values([
      { id: WA, user_id: UA, title: 'T36 WM Work A' },
      { id: WB, user_id: UB, title: 'T36 WM Work B' },
      { id: WAD, user_id: UA, title: 'T36 WM Work A Deleted', deleted_at: lit(base) },
    ])
    .execute();
  await t
    .insertInto('material')
    .values([
      // tags 必须显式给值：MySQL 8.4.13 下「JSON 列默认值 + 多值函数索引 ix_material_tags」
      // 会在 INSERT 走默认值时报 3903（实测），故与种子同口径显式落 []。
      { id: G, user_id: null, type: 'knowledge', title: 't36wm 全局', source: 'self', tags: toJsonParam([]) },
      { id: MA, user_id: UA, type: 'doc', title: 't36wm A私有', source: 'self', tags: toJsonParam([]) },
      { id: MB, user_id: UB, type: 'doc', title: 't36wm B私有', source: 'self', tags: toJsonParam([]) },
      { id: MAD, user_id: UA, type: 'doc', title: 't36wm A软删', source: 'self', deleted_at: lit(base), tags: toJsonParam([]) },
    ])
    .execute();
}

describe('T-36 WorkMaterial · collect 幂等与默认 used_in', () => {
  it('收藏本人作品 + 本人素材：count=1，list=[MA]，used_in 默认 []', () =>
    inTx(async (t) => {
      await setup(t);
      const a = createWorkMaterialRepository(t).forUser(UA);
      await a.collect(WA, MA);
      expect(await a.countForWork(WA)).toBe(1);
      expect(await a.listMaterialIdsForWork(WA)).toEqual([MA]);
      const row = await t
        .selectFrom('work_material')
        .select(['used_in', 'user_id'])
        .where('work_id', '=', WA)
        .where('material_id', '=', MA)
        .executeTakeFirstOrThrow();
      expect(row.used_in).toEqual([]);
      expect(row.user_id).toBe(UA);
    }));

  it('重复收藏同一素材不抛错不增行；收藏全局素材也可', () =>
    inTx(async (t) => {
      await setup(t);
      const a = createWorkMaterialRepository(t).forUser(UA);
      await a.collect(WA, MA);
      await a.collect(WA, MA); // 第二次：ON DUP no-op
      expect(await a.countForWork(WA)).toBe(1);
      await a.collect(WA, G); // 全局公共素材可见
      expect(await a.countForWork(WA)).toBe(2);
      expect(await a.listMaterialIdsForWork(WA)).toEqual([MA, G]); // id 升序确定性
    }));

  it('re-collect 保留既有 used_in（no-op 不抹掉引用）', () =>
    inTx(async (t) => {
      await setup(t);
      const a = createWorkMaterialRepository(t).forUser(UA);
      await a.collect(WA, MA);
      const usedIn = [{ target: 'slides', pageId: 'p1' }];
      await t
        .updateTable('work_material')
        .set({ used_in: toJsonParam(usedIn) })
        .where('work_id', '=', WA)
        .where('material_id', '=', MA)
        .execute();
      await a.collect(WA, MA); // 再收藏
      const row = await t
        .selectFrom('work_material')
        .select('used_in')
        .where('work_id', '=', WA)
        .where('material_id', '=', MA)
        .executeTakeFirstOrThrow();
      expect(row.used_in).toEqual(usedIn);
      expect(await a.countForWork(WA)).toBe(1);
    }));
});

describe('T-36 WorkMaterial · collect 纵深防御（结构化 code，且不写库）', () => {
  it('往 B 的作品收藏 → WORK_NOT_OWNED，B 的作品计数仍 0', () =>
    inTx(async (t) => {
      await setup(t);
      const a = createWorkMaterialRepository(t).forUser(UA);
      const b = createWorkMaterialRepository(t).forUser(UB);
      await expect(a.collect(WB, MA)).rejects.toMatchObject({ code: 'WORK_NOT_OWNED' });
      await expect(a.collect(WB, MA)).rejects.toBeInstanceOf(WorkNotOwnedError);
      expect(await b.countForWork(WB)).toBe(0);
    }));

  it('收藏 B 的私有素材 → MATERIAL_NOT_VISIBLE，本人作品计数仍 0', () =>
    inTx(async (t) => {
      await setup(t);
      const a = createWorkMaterialRepository(t).forUser(UA);
      await expect(a.collect(WA, MB)).rejects.toMatchObject({ code: 'MATERIAL_NOT_VISIBLE' });
      await expect(a.collect(WA, MB)).rejects.toBeInstanceOf(MaterialNotVisibleError);
      expect(await a.countForWork(WA)).toBe(0);
    }));

  it('软删作品 → WORK_NOT_OWNED；软删素材 → MATERIAL_NOT_VISIBLE', () =>
    inTx(async (t) => {
      await setup(t);
      const a = createWorkMaterialRepository(t).forUser(UA);
      await expect(a.collect(WAD, MA)).rejects.toMatchObject({ code: 'WORK_NOT_OWNED' });
      await expect(a.collect(WA, MAD)).rejects.toMatchObject({ code: 'MATERIAL_NOT_VISIBLE' });
    }));

  it('不存在的作品/素材 → 对应结构化 code', () =>
    inTx(async (t) => {
      await setup(t);
      const a = createWorkMaterialRepository(t).forUser(UA);
      await expect(a.collect('t36_wm_ghost_work', MA)).rejects.toMatchObject({ code: 'WORK_NOT_OWNED' });
      await expect(a.collect(WA, 't36_wm_ghost_mat')).rejects.toMatchObject({ code: 'MATERIAL_NOT_VISIBLE' });
    }));
});

describe('T-36 WorkMaterial · uncollect 与读写隔离', () => {
  it('uncollect 存在→true 且计数归零；absent→false', () =>
    inTx(async (t) => {
      await setup(t);
      const a = createWorkMaterialRepository(t).forUser(UA);
      await a.collect(WA, MA);
      expect(await a.uncollect(WA, MA)).toBe(true);
      expect(await a.countForWork(WA)).toBe(0);
      expect(await a.uncollect(WA, MA)).toBe(false); // 已无行
      expect(await a.uncollect(WA, G)).toBe(false); // 从未收藏
    }));

  it('跨用户 uncollect：A 删不掉 B 的收藏（false），B 的计数不变', () =>
    inTx(async (t) => {
      await setup(t);
      const a = createWorkMaterialRepository(t).forUser(UA);
      const b = createWorkMaterialRepository(t).forUser(UB);
      await b.collect(WB, G);
      expect(await a.uncollect(WB, G)).toBe(false);
      expect(await b.countForWork(WB)).toBe(1);
    }));

  it('count/list 按 work_id+user_id 双重谓词：A 看 B 的作品恒 0/[]', () =>
    inTx(async (t) => {
      await setup(t);
      const a = createWorkMaterialRepository(t).forUser(UA);
      const b = createWorkMaterialRepository(t).forUser(UB);
      await b.collect(WB, G);
      await b.collect(WB, MB);
      expect(await a.countForWork(WB)).toBe(0);
      expect(await a.listMaterialIdsForWork(WB)).toEqual([]);
      expect(await b.countForWork(WB)).toBe(2);
    }));
});

describe('T-36 WorkMaterial · 作用域与非法身份', () => {
  it.each(['', '   ', 'x'.repeat(37)])('forUser(%j) 抛 WORK_MATERIAL_SCOPE_REQUIRED', (bad) => {
    expect(() => createWorkMaterialRepository(db).forUser(bad)).toThrowError(WorkMaterialScopeRequiredError);
  });

  it('非法 workId/materialId 抛 WORK_MATERIAL_ID_INVALID（不落 SQL）', () =>
    inTx(async (t) => {
      const a = createWorkMaterialRepository(t).forUser(UA);
      await expect(a.collect('bad id!', MA)).rejects.toBeInstanceOf(WorkMaterialIdInvalidError);
      await expect(a.uncollect(WA, 'bad id!')).rejects.toMatchObject({ code: 'WORK_MATERIAL_ID_INVALID' });
      await expect(a.countForWork('bad id!')).rejects.toMatchObject({ code: 'WORK_MATERIAL_ID_INVALID' });
    }));
});

describe('T-36 WorkMaterial · listCollectedMaterialIdsForUser（素材库用户级 collected 叠加）', () => {
  it('跨 work 去重 + id 升序；只含本人收藏，不串用户', () =>
    inTx(async (t) => {
      await setup(t);
      const WA2 = 't36_wm_work_a2';
      await t.insertInto('work').values({ id: WA2, user_id: UA, title: 'T36 WM Work A2' }).execute();
      const a = createWorkMaterialRepository(t).forUser(UA);
      const b = createWorkMaterialRepository(t).forUser(UB);
      // 同一素材 MA 被两个 work 收藏 → 用户级去重只出现一次。
      await a.collect(WA, MA);
      await a.collect(WA2, MA);
      await a.collect(WA2, G);
      expect(await a.listCollectedMaterialIdsForUser()).toEqual([MA, G]); // 升序 + 去重
      // B 未收藏 → 空；B 收藏后只含 B 自己的，绝不串到 A。
      expect(await b.listCollectedMaterialIdsForUser()).toEqual([]);
      await b.collect(WB, G);
      expect(await b.listCollectedMaterialIdsForUser()).toEqual([G]);
      expect(await a.listCollectedMaterialIdsForUser()).toEqual([MA, G]);
    }));

  it('无任何收藏 → 空数组（不是 null）', () =>
    inTx(async (t) => {
      await setup(t);
      const a = createWorkMaterialRepository(t).forUser(UA);
      expect(await a.listCollectedMaterialIdsForUser()).toEqual([]);
    }));
});