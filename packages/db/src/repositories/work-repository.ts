/**
 * Work 仓储（架构 §10.1「查询隔离」/ §13「数据隔离」）。
 *
 * ## 为什么是 `forUser(userId)` 而不是每个方法收一个 userId 参数
 * 架构 §13 要求「仓储层强制 user_id 谓词」，§10.1 要求「所有列表查询强制注入 user_id，
 * 仓储层封装，禁止裸 SQL」。若每个方法都收 `userId`，隔离就退化成「调用方自觉传参」——
 * 漏传一次就是跨用户数据泄露，而这种漏传在 code review 里极易看漏。
 *
 * 故本仓储只暴露 `forUser(userId)`：拿到的是**已绑定身份**的作用域对象，
 * 其所有方法**根本没有 userId 参数**，调用方在语法上无法漏传、也无法传错到别的作用域。
 * 每条读取都从 `scoped()` 出发，该基座已带 `user_id = ?` 与 `deleted_at IS NULL`；
 * 写操作的 WHERE 亦逐条显式带上 user_id。隔离由结构保证，不靠纪律。
 *
 * ## 表类型来源与为什么入参是完整的 `Kysely<Database>`
 * `WorkTable` / `Database` 直接 import WP10 冻结的 `../schema/*.js`，**不另立第二份 schema 定义**。
 * 入参用 WP10 的**完整** `Database`（含 work 表），而不是「只含 work」的窄视图：
 * Kysely 的 `DB` 类型参数同时出现在协变与逆变位置，**是不变的（invariant）**，
 * 因此 `Kysely<Database>` 并**不可**赋值给 `Kysely<{ work: WorkTable }>`。
 * 本轮 tsc 实测窄视图写法在 17 处调用点报 TS2345（运行时因 esbuild 不做类型检查而假绿），
 * 已改为完整 `Database`，与 `createDb()` 的 `DbHandle.db: Kysely<Database>` 完全同型。
 *
 * 刻意不用 `<DB extends { work: WorkTable }>` 泛型：Kysely 的 `InsertExpression<DB,'work'>`
 * 等类型在未解析的类型参数上无法收窄，实测会报「'id' does not exist」与 eb 隐式 any
 * （本轮 tsc 已复现 5 处）。用具体 `Database` 可让全部查询构造器正确收窄，调用点无需任何断言。
 *
 * ## 参数化
 * 全部走 Kysely 查询构造器与 `sql` tagged template（后者同样把值绑成占位符）。
 * 唯一的字符串拼接是 LIKE 模式里的 `%` 包裹，且已先转义 `\ % _`，值本身仍是绑定参数。
 */
import { sql, type Kysely, type Selectable } from 'kysely';
import type { WorkStep } from '@knowstudio/contracts';
import type { Database } from '../schema/index.js';
import { nextStep, phaseOf } from '@knowstudio/domain';
import type { WorkTable } from '../schema/work.js';
import { decodeWorkCursor, encodeWorkCursor } from './work-cursor.js';

/** work 表的读取行（JSON 列已解析、DATETIME(3) 为 UTC 字面量字符串）。 */
export type WorkRow = Selectable<WorkTable>;

/** 结构化错误：调用方按 code 分支，禁止解析 message。 */
export class WorkScopeRequiredError extends Error {
  readonly code = 'WORK_SCOPE_REQUIRED';
  constructor() {
    super('仓储作用域必须绑定合法 userId：禁止无身份查询 work');
    this.name = 'WorkScopeRequiredError';
  }
}

export class WorkIdInvalidError extends Error {
  readonly code = 'WORK_ID_INVALID';
  constructor(readonly raw: string) {
    super('work id 非法：必须是非空且不超 36 字符的 ascii 标识');
    this.name = 'WorkIdInvalidError';
  }
}

export interface CreateWorkInput {
  readonly id: string;
  readonly title: string;
  readonly keyword?: string | null;
  readonly phase?: number;
  readonly step?: WorkStep;
}

export interface WorkListFilter {
  readonly phase?: number;
  /** SPEC §5 `GET /works?q=`：≥2 字走 FULLTEXT ngram，单字降级 LIKE（架构 §10.3 / §4.3.5）。 */
  readonly q?: string;
}

export interface WorkPageRequest {
  readonly limit: number;
  readonly cursor?: string;
}

export interface WorkListPage {
  readonly items: readonly WorkRow[];
  readonly nextCursor: string | null;
}

/**
 * 已绑定 userId 的作用域仓储。**方法签名里没有 userId**，这是隔离的结构性保证。
 * 所有读取一律排除软删除行（`deleted_at IS NULL`）。
 */
export interface ScopedWorkRepository {
  insert(input: CreateWorkInput): Promise<WorkRow>;
  findById(id: string): Promise<WorkRow | null>;
  list(filter: WorkListFilter, page: WorkPageRequest): Promise<WorkListPage>;
  count(filter: WorkListFilter): Promise<number>;
  /** 改名。返回 null 表示「不存在或不属于你」，与 findById 的 null 语义一致。 */
  rename(id: string, title: string): Promise<WorkRow | null>;
  /** 选定选题并推进到文案步；已处在更后阶段的 Work 不回退。 */
  selectTopic(id: string, topicId: string): Promise<WorkRow | null>;
  /** 软删除。返回 false 表示「不存在或不属于你」。 */
  softDelete(id: string): Promise<boolean>;
}

export interface WorkRepository {
  forUser(userId: string): ScopedWorkRepository;
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,36}$/;

function assertId(raw: string): string {
  if (typeof raw !== 'string' || !ID_PATTERN.test(raw)) throw new WorkIdInvalidError(raw);
  return raw;
}

/** LIKE 模式转义：`\ % _` 是 LIKE 元字符，不转义会让用户输入的 `%` 变成通配符。 */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export function createWorkRepository(db: Kysely<Database>): WorkRepository {
  return {
    forUser(userId: string): ScopedWorkRepository {
      // 无身份 / 空身份一律拒绝：宁可报错，也不退化成「查全表」。
      if (typeof userId !== 'string' || !ID_PATTERN.test(userId))
        throw new WorkScopeRequiredError();

      /** 所有读取的唯一入口：user_id 谓词 + 软删除过滤都在这里，不在调用方。 */
      const scoped = () =>
        db.selectFrom('work').where('user_id', '=', userId).where('deleted_at', 'is', null);

      type Base = ReturnType<typeof scoped>;

      /**
       * 搜索谓词。抽成函数以保证 list 与 count 的过滤口径**完全一致**（否则 total 与 items 会打架）。
       *
       * 策略依据架构 §10.3 / §4.3.5：`q` 走 FULLTEXT ngram，**单字查询降级 LIKE**。
       * 实例 ngram_token_size=2，1 个字符无法成词，若不降级会「不报错但返回空」——
       * 正是 §4.3.5 要消灭的静默失效。码点计数用 [...term] 而非 .length，
       * 避免把单个 astral 字符的 UTF-16 双码元误判成 2 字而错走全文路径。
       * InnoDB 的 FULLTEXT 索引同步存在短暂窗口；多字查询再 OR 精确 LIKE，
       * 保证新写入作品立即可搜，同时保留 ngram 的中文召回能力。
       */
      const withSearch = (qb: Base, q: string | undefined): Base => {
        const term = q?.trim();
        if (term === undefined || term === '') return qb;
        if ([...term].length >= 2) {
          return qb.where((eb) =>
            eb.or([
              sql<boolean>`MATCH(title) AGAINST (${term} IN NATURAL LANGUAGE MODE)`,
              eb('title', 'like', `%${escapeLike(term)}%`),
            ]),
          );
        }
        return qb.where('title', 'like', `%${escapeLike(term)}%`);
      };

      const withPhase = (qb: Base, phase: number | undefined): Base =>
        phase === undefined ? qb : qb.where('phase', '=', phase);

      return {
        async insert(input: CreateWorkInput): Promise<WorkRow> {
          const id = assertId(input.id);
          await db
            .insertInto('work')
            .values({
              id,
              // user_id 来自作用域，**不接受 input 传入**：调用方无法把行写到别人名下。
              user_id: userId,
              title: input.title,
              keyword: input.keyword ?? null,
              ...(input.phase === undefined ? {} : { phase: input.phase }),
              ...(input.step === undefined ? {} : { step: input.step }),
              // gates / gates_fingerprint 不写：DDL 默认全 false，权威判定一律走 domain.deriveGates。
              // created_at / updated_at 由服务端 CURRENT_TIMESTAMP(3) 填，避免应用时钟漂移。
            })
            .execute();

          // 回读以取得服务端默认值（created_at/updated_at/gates），而不是回显入参冒充落库结果。
          const row = await scoped().where('id', '=', id).selectAll().executeTakeFirst();
          if (row === undefined) throw new WorkIdInvalidError(id);
          return row;
        },

        async findById(id: string): Promise<WorkRow | null> {
          const row = await scoped().where('id', '=', assertId(id)).selectAll().executeTakeFirst();
          return row ?? null;
        },

        async list(filter: WorkListFilter, page: WorkPageRequest): Promise<WorkListPage> {
          const limit = page.limit;
          let qb = withPhase(withSearch(scoped(), filter.q), filter.phase);

          if (page.cursor !== undefined) {
            const c = decodeWorkCursor(page.cursor);
            // keyset：(updated_at,id) 严格小于游标位置。DESC 排序下即「下一页」。
            qb = qb.where((eb) =>
              eb.or([
                eb('updated_at', '<', c.u),
                eb.and([eb('updated_at', '=', c.u), eb('id', '<', c.i)]),
              ]),
            );
          }

          // 多取 1 条用于判断是否还有下一页，避免「最后一页返回空才知道到底了」。
          const rows = await qb
            .orderBy('updated_at', 'desc')
            .orderBy('id', 'desc')
            .limit(limit + 1)
            .selectAll()
            .execute();

          const hasMore = rows.length > limit;
          const items = hasMore ? rows.slice(0, limit) : rows;
          const last = items[items.length - 1];
          const nextCursor =
            hasMore && last !== undefined
              ? encodeWorkCursor({ u: last.updated_at, i: last.id })
              : null;
          return { items, nextCursor };
        },

        async count(filter: WorkListFilter): Promise<number> {
          const row = await withPhase(withSearch(scoped(), filter.q), filter.phase)
            .select(sql<string>`COUNT(*)`.as('count'))
            .executeTakeFirstOrThrow();
          return Number(row.count);
        },

        async rename(id: string, title: string): Promise<WorkRow | null> {
          const workId = assertId(id);
          await db
            .updateTable('work')
            .set({ title })
            .where('id', '=', workId)
            .where('user_id', '=', userId)
            .where('deleted_at', 'is', null)
            .execute();

          // 刻意**不**用 affectedRows 判成败：MySQL 默认 affectedRows 只数「真正变化」的行，
          // 改成同名标题时为 0，会把「存在且属于你」误判成 404。故一律回读判定。
          const row = await scoped().where('id', '=', workId).selectAll().executeTakeFirst();
          return row ?? null;
        },

        async selectTopic(id: string, topicId: string): Promise<WorkRow | null> {
          const workId = assertId(id);
          const current = await scoped().where('id', '=', workId).selectAll().executeTakeFirst();
          if (current === undefined) return null;
          const step = nextStep(current.step, 'topic:select');
          await db
            .updateTable('work')
            .set({ selected_topic_id: assertId(topicId), step, phase: phaseOf(step) })
            .where('id', '=', workId)
            .where('user_id', '=', userId)
            .where('deleted_at', 'is', null)
            .execute();
          return (await scoped().where('id', '=', workId).selectAll().executeTakeFirst()) ?? null;
        },

        async softDelete(id: string): Promise<boolean> {
          const workId = assertId(id);
          const result = await db
            .updateTable('work')
            .set({ deleted_at: sql`CURRENT_TIMESTAMP(3)` })
            .where('id', '=', workId)
            .where('user_id', '=', userId)
            .where('deleted_at', 'is', null)
            .executeTakeFirst();
          // 这里可以安全用 affectedRows：deleted_at 由 NULL 变时间戳，必然是真实变化。
          return Number(result.numUpdatedRows) > 0;
        },
      };
    },
  };
}
