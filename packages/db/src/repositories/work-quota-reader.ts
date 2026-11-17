/**
 * 配额读取器（架构 §7.1 / SPEC §5 QuotaAccount）。
 *
 * ## 唯一真相与 fail-closed
 * 信封里的 quota 直接读 `quota_account` 的 total/used/reserved/reset_at，
 * `left = total - used - reserved` 派生（**无 stored left 列**，SPEC §5）。
 * 这与「设置页消耗明细由 quota_ledger 聚合」不矛盾：account.used 由 commit 事务维护，
 * 种子实测 SUM(ledger.commit)=22=account.used，两者同源（D-22 对策）。
 *
 * 缺账本行 / 恒等式被破坏一律**抛错**，绝不退化成「默认 0 点」或「默认满额度」——
 * 那会重新长出 D-22。QuotaSchema.parse 兜底校验 left 恒等式与 used+reserved<=total。
 *
 * ## 为什么在 packages/db 而不是 apps/api
 * 聚合读需要 Kysely；apps/api 未声明 kysely 依赖（pnpm 严格隔离），故 DB 适配器落在本包，
 * 由 apps/api 的 works.module 经 useFactory 绑定到 WORK_QUOTA_READER 令牌。
 */
import type { Kysely } from 'kysely';
import { QuotaSchema, type Quota } from '@knowstudio/contracts';
import type { Database } from '../schema/index.js';

/** 结构化错误：调用方按 code 分支，禁止解析 message。 */
export class QuotaAccountMissingError extends Error {
  readonly code = 'QUOTA_ACCOUNT_MISSING';
  constructor(readonly userId: string) {
    super('用户没有配额账本行：拒绝下发默认额度（fail-closed，杜绝 D-22）');
    this.name = 'QuotaAccountMissingError';
  }
}

export class QuotaTimestampInvalidError extends Error {
  readonly code = 'QUOTA_TIMESTAMP_INVALID';
  constructor(readonly raw: string) {
    super('quota_account.reset_at 不是 DATETIME(3) UTC 字面量，拒绝下发歧义时间');
    this.name = 'QuotaTimestampInvalidError';
  }
}

/** 与 apps/api work-envelope.toRfc3339 同一口径：只换分隔符 + 补 Z，不经 new Date()。 */
const DB_UTC_LITERAL = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/;
function toRfc3339(literal: string): string {
  if (!DB_UTC_LITERAL.test(literal)) throw new QuotaTimestampInvalidError(literal);
  return `${literal.replace(' ', 'T')}Z`;
}

/** 端口形状（与 apps/api/src/works/work-ports.ts 的 WorkQuotaReader 结构一致）。 */
export interface WorkQuotaReader {
  readForUser(userId: string): Promise<Quota>;
}

export function createWorkQuotaReader(db: Kysely<Database>): WorkQuotaReader {
  return {
    async readForUser(userId: string): Promise<Quota> {
      const row = await db
        .selectFrom('quota_account')
        .select(['total', 'used', 'reserved', 'reset_at'])
        .where('user_id', '=', userId)
        .executeTakeFirst();

      // 无账本行即抛错：绝不返回 {total:0,...} 冒充「没有额度」。
      if (row === undefined) throw new QuotaAccountMissingError(userId);

      const total = Number(row.total);
      const used = Number(row.used);
      const reserved = Number(row.reserved);
      const left = total - used - reserved;

      // parse 会校验 left 恒等式与 used+reserved<=total；任何漂移在此抛错而非下发。
      return QuotaSchema.parse({
        total,
        used,
        reserved,
        left,
        resetAt: toRfc3339(row.reset_at),
      });
    },
  };
}