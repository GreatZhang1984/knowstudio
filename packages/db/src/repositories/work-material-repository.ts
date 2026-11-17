/**
 * 作品-素材引用仓储（T-21 / 架构 §4.4 work_material / SPEC §3.2 收藏即建立 WorkMaterial 引用）。
 *
 * ## 隔离
 * forUser(userId) 作用域：work_material.user_id 是冗余隔离列，所有读写都带 user_id 谓词。
 * collect/uncollect 的 workId 须先经 API 层 OwnershipGuard 校验归属（路由 /works/:id/materials），
 * 与 WorkTruthSnapshotLoader 接收已校验 work 行同一约定；仓储仍以 user_id 兜底，绝不跨用户读写。
 *
 * ## 纵深防御（collect 写前校验，结构化 code，校验失败绝不写库）
 * 即便 API 层已校验，仓储再兜一层：① work 必须存在/属于本人/未软删，否则 WorkNotOwnedError；
 * ② material 必须对本人可见（自有 OR 全局 NULL）且未软删，否则 MaterialNotVisibleError。
 * 这是「最后一道写前闸」，避免任何调用路径把引用写到别人作品或不可见素材上。
 *
 * ## 幂等收藏
 * PK(work_id, material_id)。collect 用 INSERT ... ON DUPLICATE KEY UPDATE collected_at=collected_at
 * （自赋值 no-op）保证重复收藏不报错、不重置 collected_at/used_in、不产生第二行。
 * collect 返回 void（冻结接口）；是否首次收藏由调用方按需自行点查，本仓储不发明埋点基础设施。
 *
 * ## used_in
 * 收藏时 used_in 落空数组（尚未用于课件/文案）；局部微调写 used_in 属做视频阶段（T-35+），本批不动。
 */
import { sql, type Kysely } from 'kysely';
import type { Database } from '../schema/index.js';
import { toJsonParam } from '../schema/column-types.js';

export class WorkMaterialScopeRequiredError extends Error {
  readonly code = 'WORK_MATERIAL_SCOPE_REQUIRED';
  constructor() {
    super('work_material 仓储作用域必须绑定合法 userId：禁止无身份查询');
    this.name = 'WorkMaterialScopeRequiredError';
  }
}

export class WorkMaterialIdInvalidError extends Error {
  readonly code = 'WORK_MATERIAL_ID_INVALID';
  constructor(readonly raw: string) {
    super('work/material id 非法：必须是非空且不超 36 字符的 ascii 标识');
    this.name = 'WorkMaterialIdInvalidError';
  }
}

/**
 * 纵深防御：collect 的目标 work 不属于当前 userId（含不存在 / 软删）。
 * API 层 OwnershipGuard 已先校验，仓储再兜一层——绝不把引用写到别人作品名下。
 */
export class WorkNotOwnedError extends Error {
  readonly code = 'WORK_NOT_OWNED';
  constructor(readonly workId: string) {
    super('作品不存在或不属于当前用户：拒绝收藏');
    this.name = 'WorkNotOwnedError';
  }
}

/**
 * 纵深防御：collect 的目标 material 对当前 userId 不可见（他人私有 / 不存在 / 软删）。
 * 全局公共库（user_id NULL）与本人私有可见；其余一律拒绝，绝不引用不可见素材。
 */
export class MaterialNotVisibleError extends Error {
  readonly code = 'MATERIAL_NOT_VISIBLE';
  constructor(readonly materialId: string) {
    super('素材不存在或对当前用户不可见：拒绝收藏');
    this.name = 'MaterialNotVisibleError';
  }
}

export interface ScopedWorkMaterialRepository {
  /** 幂等收藏：work 非本人 / material 不可见时抛结构化 code，绝不写库。 */
  collect(workId: string, materialId: string): Promise<void>;
  /** 取消收藏。false = 原本就没收藏（幂等）。 */
  uncollect(workId: string, materialId: string): Promise<boolean>;
  countForWork(workId: string): Promise<number>;
  /** 当前 work 已收藏的素材 id（搜索页 collected 叠加），按 material_id 升序确定性返回。 */
  listMaterialIdsForWork(workId: string): Promise<string[]>;
  /**
   * 当前用户**任一 work** 已收藏的素材 id（素材库 collected 叠加，架构 §3.9 / D-21）。
   * 跨 work 去重（同一素材可被多个 work 收藏），按 material_id 升序确定性返回。
   */
  listCollectedMaterialIdsForUser(): Promise<string[]>;
}

export interface WorkMaterialRepository {
  forUser(userId: string): ScopedWorkMaterialRepository;
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,36}$/;

function assertId(raw: string): string {
  if (typeof raw !== 'string' || !ID_PATTERN.test(raw)) throw new WorkMaterialIdInvalidError(raw);
  return raw;
}

export function createWorkMaterialRepository(db: Kysely<Database>): WorkMaterialRepository {
  return {
    forUser(userId: string): ScopedWorkMaterialRepository {
      if (typeof userId !== 'string' || !ID_PATTERN.test(userId)) {
        throw new WorkMaterialScopeRequiredError();
      }

      const scoped = () => db.selectFrom('work_material').where('user_id', '=', userId);

      return {
        async collect(workId: string, materialId: string): Promise<void> {
          const w = assertId(workId);
          const m = assertId(materialId);

          // 纵深防御①：work 必须存在、属于本人、未软删。否则不写库，抛结构化 code。
          const ownedWork = await db
            .selectFrom('work')
            .select('id')
            .where('id', '=', w)
            .where('user_id', '=', userId)
            .where('deleted_at', 'is', null)
            .executeTakeFirst();
          if (ownedWork === undefined) throw new WorkNotOwnedError(w);

          // 纵深防御②：material 必须对本人可见（自有 OR 全局 NULL）且未软删。
          const visibleMaterial = await db
            .selectFrom('material')
            .select('id')
            .where('id', '=', m)
            .where((eb) => eb.or([eb('user_id', '=', userId), eb('user_id', 'is', null)]))
            .where('deleted_at', 'is', null)
            .executeTakeFirst();
          if (visibleMaterial === undefined) throw new MaterialNotVisibleError(m);

          // 幂等：PK(work_id,material_id) 冲突时自赋值 no-op，不报错、不增行、不重置 collected_at/used_in。
          await db
            .insertInto('work_material')
            .values({ work_id: w, material_id: m, user_id: userId, used_in: toJsonParam([]) })
            .onDuplicateKeyUpdate({ collected_at: sql`collected_at` })
            .execute();
        },

        async uncollect(workId: string, materialId: string): Promise<boolean> {
          const result = await db
            .deleteFrom('work_material')
            .where('work_id', '=', assertId(workId))
            .where('material_id', '=', assertId(materialId))
            .where('user_id', '=', userId)
            .executeTakeFirst();
          return Number(result.numDeletedRows) > 0;
        },

        async countForWork(workId: string): Promise<number> {
          const row = await scoped()
            .where('work_id', '=', assertId(workId))
            .select(sql<string>`COUNT(*)`.as('count'))
            .executeTakeFirstOrThrow();
          return Number(row.count);
        },

        async listMaterialIdsForWork(workId: string): Promise<string[]> {
          const rows = await scoped()
            .where('work_id', '=', assertId(workId))
            .select('material_id')
            .orderBy('material_id', 'asc')
            .execute();
          return rows.map((r) => r.material_id);
        },

        async listCollectedMaterialIdsForUser(): Promise<string[]> {
          const rows = await scoped()
            .select('material_id')
            .orderBy('material_id', 'asc')
            .execute();
          // 同一素材可被多个 work 收藏 → 去重；查询已升序，Set 保持该确定性顺序。
          return [...new Set(rows.map((r) => r.material_id))];
        },
      };
    },
  };
}