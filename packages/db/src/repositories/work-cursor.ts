/**
 * Work 列表的不透明游标（架构 §10.1：`?limit=20&cursor=<opaque>`，游标基于 `(updated_at,id)`，
 * 避免深翻页 OFFSET）。
 *
 * 为什么是 (updated_at,id) 而不是单纯 updated_at：
 *   work.updated_at 只到 DATETIME(3) 毫秒精度，同一毫秒内创建/改名的多条作品会并列。
 *   只按 updated_at 翻页会在并列处漏行或重复行。补上主键 id 作为第二排序键后全序唯一，
 *   keyset 谓词才能做到「无重叠无遗漏」。
 *
 * 为什么 opaque：游标是服务端内部排序键，不是对外契约字段。编码成 base64url 后
 *   ① 前端不会误当业务字段解析；② 结构变更不破坏既有客户端；③ 非法游标在入口即被拒，
 *   而不是拼进 SQL 造成注入面（本模块只做编解码，SQL 侧一律 Kysely 参数化）。
 */

/** DATETIME(3) 的 UTC 字面量：`YYYY-MM-DD HH:mm:ss.SSS`（与 WP10 column-types.UtcDateTime 同口径）。 */
const UTC_DATETIME_LITERAL = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/;

/** CHAR(36) ascii_bin 主键。 */
const WORK_ID = /^[A-Za-z0-9_-]{1,36}$/;

export interface WorkCursor {
  /** updated_at 的 UTC 字面量。 */
  readonly u: string;
  /** 同毫秒并列时的 tie-breaker：主键 id。 */
  readonly i: string;
}

/**
 * 结构化错误：一律带稳定 `code`，调用方按 code 分支。
 * 刻意不靠 error.message 判定类型（本机工程纪律）。
 */
export class WorkCursorInvalidError extends Error {
  readonly code = 'WORK_CURSOR_INVALID';
  constructor(readonly raw: string) {
    super('分页游标非法：必须是服务端下发的 opaque cursor');
    this.name = 'WorkCursorInvalidError';
  }
}

export function encodeWorkCursor(cursor: WorkCursor): string {
  return Buffer.from(JSON.stringify({ u: cursor.u, i: cursor.i }), 'utf8').toString('base64url');
}

/**
 * 解码并**严格校验**形状。任何不符一律抛 WorkCursorInvalidError，
 * 绝不「尽力解析」后把半个游标带进 WHERE —— 那会静默返回错误页而非报错。
 */
export function decodeWorkCursor(raw: string): WorkCursor {
  let parsed: unknown;
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    parsed = JSON.parse(json);
  } catch {
    throw new WorkCursorInvalidError(raw);
  }
  if (typeof parsed !== 'object' || parsed === null) throw new WorkCursorInvalidError(raw);

  const u = (parsed as Record<string, unknown>)['u'];
  const i = (parsed as Record<string, unknown>)['i'];
  if (typeof u !== 'string' || !UTC_DATETIME_LITERAL.test(u)) throw new WorkCursorInvalidError(raw);
  if (typeof i !== 'string' || !WORK_ID.test(i)) throw new WorkCursorInvalidError(raw);

  // base64url 解码对非法字符是宽容的（会丢弃），故必须回编码比对，
  // 否则 `!!!` 之类垃圾串可能碰巧解出合法 JSON 而被放行。
  if (encodeWorkCursor({ u, i }) !== raw) throw new WorkCursorInvalidError(raw);

  return { u, i };
}