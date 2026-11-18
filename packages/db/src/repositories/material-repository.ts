/**
 * 素材仓储（T-21 / 架构 §4.4 material / §3.9 素材库最小可用 / §10.1 游标分页）。
 *
 * ## 可见性（架构 §13 数据隔离 + 全局公共库）
 * material.user_id NULL = 全局公共库（种子 p2/p3）。用户可见 = 自有（user_id=userId）+ 全局（NULL）。
 * 所有读写都从 `visible()` 出发，该基座已带 (user_id=userId OR NULL) 与 deleted_at IS NULL，
 * 调用方在语法上无法漏掉隔离谓词。软删除行一律排除。
 *
 * ## 检索（与 work-repository 同口径的 LIKE 子串匹配）
 * 素材库 q 是「标题包含」语义：一律 LIKE '%term%'，先转义 `\ % _` 元字符再绑定参数。
 * 刻意**不**用 FULLTEXT MATCH：ngram 自然语言模式是 OR 语义，`下划_线` 会连带命中 `下划X线`，
 * 且单字/元字符在 ngram_token_size=2 下静默返空。LIKE 对单字与 `%`/`_` 字面量都确定可见。
 *
 * ## 游标
 * 复用 work-cursor 的不透明 {u,i} 编解码（generic）：material 无 updated_at，故 u=created_at。
 * (created_at,id) 全序唯一，keyset 无重叠无遗漏。非法游标抛 MATERIAL_CURSOR_INVALID，API 层映射 400。
 *
 * ## collected 不在本仓储算
 * Material.collected 是「是否被收藏进某 work」，属 work_material 引用关系，由 API 层叠加
 * （搜索按当前 work、素材库按用户任一 work），本仓储只返回素材真相行，不谎报收藏态（D-04 同源精神）。
 */
import { sql, type Kysely, type Selectable } from 'kysely';
import type { LicenseState, Material, MaterialType } from '@knowstudio/contracts';
import type { Database } from '../schema/index.js';
import type { MaterialTable } from '../schema/work.js';
import { toJsonParam } from '../schema/column-types.js';
import { decodeWorkCursor, encodeWorkCursor, WorkCursorInvalidError } from './work-cursor.js';

export type MaterialRow = Selectable<MaterialTable>;

export class MaterialScopeRequiredError extends Error {
  readonly code = 'MATERIAL_SCOPE_REQUIRED';
  constructor() {
    super('素材仓储作用域必须绑定合法 userId：禁止无身份查询');
    this.name = 'MaterialScopeRequiredError';
  }
}

export class MaterialIdInvalidError extends Error {
  readonly code = 'MATERIAL_ID_INVALID';
  constructor(readonly raw: string) {
    super('material id 非法：必须是非空且不超 36 字符的 ascii 标识');
    this.name = 'MaterialIdInvalidError';
  }
}

/** 素材库游标非法（与 work 游标同形 {u,i}，但对外暴露独立 code，便于 API 层分别映射）。 */
export class MaterialCursorInvalidError extends Error {
  readonly code = 'MATERIAL_CURSOR_INVALID';
  constructor(readonly raw: string) {
    super('素材库分页游标非法：必须是服务端下发的 opaque cursor');
    this.name = 'MaterialCursorInvalidError';
  }
}

export interface LibraryFilter {
  readonly q?: string;
  readonly type?: MaterialType;
  readonly license?: LicenseState;
}

export interface MaterialPageRequest {
  readonly limit: number;
  readonly cursor?: string;
}

export interface MaterialPage {
  readonly items: readonly MaterialRow[];
  readonly nextCursor: string | null;
}

export interface ScopedMaterialRepository {
  /** T-64：真实外部源素材按当前用户落库；稳定 ID 保证重复搜索可复用。 */
  upsertExternalMaterials(materials: readonly Material[]): Promise<void>;
  /** 按 id 批量取可见素材（收藏校验 / 搜索结果回填）。按 id 升序确定性排序，调用方自行按 id 索引。 */
  findByIds(ids: readonly string[]): Promise<MaterialRow[]>;
  listLibrary(filter: LibraryFilter, page: MaterialPageRequest): Promise<MaterialPage>;
  countLibrary(filter: LibraryFilter): Promise<number>;
}

export interface MaterialRepository {
  forUser(userId: string): ScopedMaterialRepository;
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,36}$/;

function assertId(raw: string): string {
  if (typeof raw !== 'string' || !ID_PATTERN.test(raw)) throw new MaterialIdInvalidError(raw);
  return raw;
}

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export function createMaterialRepository(db: Kysely<Database>): MaterialRepository {
  return {
    forUser(userId: string): ScopedMaterialRepository {
      if (typeof userId !== 'string' || !ID_PATTERN.test(userId))
        throw new MaterialScopeRequiredError();

      /** 所有读取的唯一入口：可见性（自有 OR 全局）+ 软删除过滤都在这里。 */
      const visible = () =>
        db
          .selectFrom('material')
          .where((eb) => eb.or([eb('user_id', '=', userId), eb('user_id', 'is', null)]))
          .where('deleted_at', 'is', null);

      type Base = ReturnType<typeof visible>;

      const withSearch = (qb: Base, q: string | undefined): Base => {
        const term = q?.trim();
        if (term === undefined || term === '') return qb;
        return qb.where('title', 'like', `%${escapeLike(term)}%`);
      };

      const withType = (qb: Base, type: MaterialType | undefined): Base =>
        type === undefined ? qb : qb.where('type', '=', type);

      const withLicense = (qb: Base, license: LicenseState | undefined): Base =>
        license === undefined ? qb : qb.where('license', '=', license);

      const filtered = (filter: LibraryFilter): Base =>
        withLicense(withType(withSearch(visible(), filter.q), filter.type), filter.license);

      return {
        async upsertExternalMaterials(materials: readonly Material[]): Promise<void> {
          if (materials.length === 0) return;
          const fetchedAt = new Date().toISOString().replace('T', ' ').replace('Z', '');
          for (const material of materials) {
            await db
              .insertInto('material')
              .values({
                id: assertId(material.id),
                user_id: userId,
                type: material.type,
                title: material.title,
                source: material.source,
                source_url: material.url,
                source_color: null,
                meta: toJsonParam({}),
                body_text: material.summary,
                storage_key: null,
                license: material.license,
                license_evidence: null,
                tags: toJsonParam([]),
                fetched_at: fetchedAt,
              })
              .onDuplicateKeyUpdate({
                title: material.title,
                source: material.source,
                source_url: material.url,
                body_text: material.summary,
                license: material.license,
                fetched_at: fetchedAt,
              })
              .execute();
          }
        },

        async findByIds(ids: readonly string[]): Promise<MaterialRow[]> {
          const clean = ids.map(assertId);
          if (clean.length === 0) return [];
          return visible().where('id', 'in', clean).orderBy('id', 'asc').selectAll().execute();
        },

        async listLibrary(filter: LibraryFilter, page: MaterialPageRequest): Promise<MaterialPage> {
          const limit = page.limit;
          let qb = filtered(filter);

          if (page.cursor !== undefined) {
            let c;
            try {
              c = decodeWorkCursor(page.cursor);
            } catch (err) {
              // 只把「游标形状非法」转成素材库专属 code；其它异常原样上抛，不吞。
              if (err instanceof WorkCursorInvalidError)
                throw new MaterialCursorInvalidError(page.cursor);
              throw err;
            }
            qb = qb.where((eb) =>
              eb.or([
                eb('created_at', '<', c.u),
                eb.and([eb('created_at', '=', c.u), eb('id', '<', c.i)]),
              ]),
            );
          }

          const rows = await qb
            .orderBy('created_at', 'desc')
            .orderBy('id', 'desc')
            .limit(limit + 1)
            .selectAll()
            .execute();

          const hasMore = rows.length > limit;
          const items = hasMore ? rows.slice(0, limit) : rows;
          const last = items[items.length - 1];
          const nextCursor =
            hasMore && last !== undefined
              ? encodeWorkCursor({ u: last.created_at, i: last.id })
              : null;
          return { items, nextCursor };
        },

        async countLibrary(filter: LibraryFilter): Promise<number> {
          const row = await filtered(filter)
            .select(sql<string>`COUNT(*)`.as('count'))
            .executeTakeFirstOrThrow();
          return Number(row.count);
        },
      };
    },
  };
}
