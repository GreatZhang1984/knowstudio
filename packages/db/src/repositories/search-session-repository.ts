/**
 * 搜索会话仓储（T-20 / 架构 §4.4 search_session / §9.4 24h 缓存 / §10.4 202+轮询）。
 *
 * ## 隔离与归属
 * 沿用 work-repository 的 `forUser(userId)` 作用域：所有读写都带 user_id 谓词，
 * 「不属于你」与「不存在」同样表现为 null（404 不可区分，架构 §10.1 / §13）。
 * `work_id` 的归属由调用方（discover 服务）先经 work 仓储校验后再传入——
 * 与 WorkTruthSnapshotLoader.load 接收「已过 OwnershipGuard 的 work 行」同一约定：
 * 仓储信任调用方已完成归属校验，但仍以 user_id 作用域兜底，绝不跨用户读写。
 *
 * ## 缓存（§9.4）
 * findCached 按 (keyword, domain, user_id, 24h 窗口) 命中最近一条 succeeded 会话。
 * domain 用 NULL-safe `<=>`：NULL 命中 NULL、非 NULL 命中同值，避免 `= NULL` 恒假静默失效。
 * 窗口下界 since 由服务按 now-24h 计算成 JS Date 传入，仓储转 UTC 字面量比较，不自行取时钟。
 * 缓存命中后由 API 层用 contracts zod 复验形状（旧种子行是 legacy 形状 → 复验失败 → 视为未命中重跑）。
 *
 * ## JSON 列
 * saturation/blank_angles/material_ids/partial_errors 写入一律 JSON.stringify（toJsonParam），
 * 读出是已解析值；值域校验由 contracts 在 API 边界负责，DB 层只保证合法 JSON（column-types 约定）。
 * keyword_hash 是 STORED 生成列 MD5(keyword)，插入/更新类型里自动排除，绝不手写。
 */
import { sql, type Kysely, type Selectable } from 'kysely';
import type { BlankAngle, JobStatus, Saturation } from '@knowstudio/contracts';
import type { Database } from '../schema/index.js';
import type { SearchSessionTable } from '../schema/discover.js';
import { toJsonParam } from '../schema/column-types.js';

/** search_session 读取行（JSON 列已解析、DATETIME(3) 为 UTC 字面量、cache_hit 为 0|1）。 */
export type SearchSessionRow = Selectable<SearchSessionTable>;

export class SearchSessionScopeRequiredError extends Error {
  readonly code = 'SEARCH_SESSION_SCOPE_REQUIRED';
  constructor() {
    super('搜索会话仓储作用域必须绑定合法 userId：禁止无身份查询');
    this.name = 'SearchSessionScopeRequiredError';
  }
}

export class SearchSessionIdInvalidError extends Error {
  readonly code = 'SEARCH_SESSION_ID_INVALID';
  constructor(readonly raw: string) {
    super('search session id 非法：必须是非空且不超 36 字符的 ascii 标识');
    this.name = 'SearchSessionIdInvalidError';
  }
}

export interface CreateSearchSessionInput {
  readonly id: string;
  /** 调用方须先校验该 work 属于当前 userId（discover 服务经 work 仓储 findById 确认）。 */
  readonly workId: string;
  readonly keyword: string;
  readonly domain?: string | null;
}

/** 聚合完成后落库的结果（API 层已用 contracts 校验过的形状）。 */
export interface SearchSessionResults {
  readonly status: JobStatus;
  readonly saturation: Saturation | null;
  readonly blankAngles: BlankAngle[];
  readonly materialIds: string[];
  readonly partialErrors: { source: string; code: string; message: string }[];
  readonly durationMs: number | null;
  readonly cacheHit: boolean;
}

export interface ScopedSearchSessionRepository {
  insert(input: CreateSearchSessionInput): Promise<SearchSessionRow>;
  findById(id: string): Promise<SearchSessionRow | null>;
  /** 落聚合结果并回读；null 表示「不存在或不属于你」。 */
  updateResults(id: string, results: SearchSessionResults): Promise<SearchSessionRow | null>;
  /**
   * 24h 缓存查找：同 (keyword, domain) 最近一条 succeeded 会话。
   * `since` 是窗口下界（JS Date），由服务按 now-24h 计算，仓储转 UTC 字面量比较，不自行取时钟。
   */
  findCached(keyword: string, domain: string | null, since: Date): Promise<SearchSessionRow | null>;
}

export interface SearchSessionRepository {
  forUser(userId: string): ScopedSearchSessionRepository;
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,36}$/;

function assertId(raw: string): string {
  if (typeof raw !== 'string' || !ID_PATTERN.test(raw)) throw new SearchSessionIdInvalidError(raw);
  return raw;
}

/** JS Date → DATETIME(3) UTC 字面量（与 seed.utcLiteral / work-cursor 同口径）。 */
function toUtcLiteral(d: Date): string {
  return d.toISOString().replace('T', ' ').replace('Z', '');
}

export function createSearchSessionRepository(db: Kysely<Database>): SearchSessionRepository {
  return {
    forUser(userId: string): ScopedSearchSessionRepository {
      if (typeof userId !== 'string' || !ID_PATTERN.test(userId)) {
        throw new SearchSessionScopeRequiredError();
      }

      const scoped = () => db.selectFrom('search_session').where('user_id', '=', userId);

      return {
        async insert(input: CreateSearchSessionInput): Promise<SearchSessionRow> {
          const id = assertId(input.id);
          await db
            .insertInto('search_session')
            .values({
              id,
              work_id: assertId(input.workId),
              user_id: userId,
              keyword: input.keyword,
              domain: input.domain ?? null,
              // keyword_hash 是 STORED 生成列，不写。
              // status/cache_hit/blank_angles/material_ids/partial_errors 走 DDL 默认
              // （'queued' / 0 / 空 JSON 数组）；saturation 留 NULL（聚合未完成）；
              // created_at 由服务端 CURRENT_TIMESTAMP(3) 填，避免应用时钟漂移。
            })
            .execute();

          const row = await scoped().where('id', '=', id).selectAll().executeTakeFirst();
          if (row === undefined) throw new SearchSessionIdInvalidError(id);
          return row;
        },

        async findById(id: string): Promise<SearchSessionRow | null> {
          const row = await scoped().where('id', '=', assertId(id)).selectAll().executeTakeFirst();
          return row ?? null;
        },

        async updateResults(id: string, results: SearchSessionResults): Promise<SearchSessionRow | null> {
          const sessionId = assertId(id);
          await db
            .updateTable('search_session')
            .set({
              status: results.status,
              saturation: results.saturation === null ? null : toJsonParam(results.saturation),
              blank_angles: toJsonParam(results.blankAngles),
              material_ids: toJsonParam(results.materialIds),
              partial_errors: toJsonParam(results.partialErrors),
              duration_ms: results.durationMs,
              cache_hit: results.cacheHit ? 1 : 0,
            })
            .where('id', '=', sessionId)
            .where('user_id', '=', userId)
            .execute();

          // 回读判定（不用 affectedRows：同名结果重复落库时 affectedRows 可能为 0）。
          const row = await scoped().where('id', '=', sessionId).selectAll().executeTakeFirst();
          return row ?? null;
        },

        async findCached(keyword: string, domain: string | null, since: Date): Promise<SearchSessionRow | null> {
          const row = await scoped()
            .where('keyword', '=', keyword)
            // NULL-safe 相等：NULL <=> NULL 为真，避免 `domain = NULL` 恒假静默漏命中。
            .where(sql<boolean>`${sql.ref('domain')} <=> ${domain}`)
            .where('status', '=', 'succeeded')
            .where('created_at', '>=', toUtcLiteral(since))
            .orderBy('created_at', 'desc')
            // 同毫秒并列时按 id DESC 取确定性的一条。
            .orderBy('id', 'desc')
            .limit(1)
            .selectAll()
            .executeTakeFirst();
          return row ?? null;
        },
      };
    },
  };
}