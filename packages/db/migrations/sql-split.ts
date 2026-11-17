/**
 * SQL 语句切分与注释剥离（零依赖，纯函数，可单测）。
 *
 * 为什么不能用 `sql.split(';')`：
 *   0001_baseline.sql 是架构 §4.4 的**逐字节副本**，其头部注释里就带分号
 *   （`-- 前置：SET NAMES utf8mb4; 连接 time_zone='+00:00';`），
 *   列注释里还带单引号（`-- '9:16' | '16:9'`、`-- [{target:'slides',pageId:'p2'}]`）。
 *   朴素切分会把注释切碎、把引号误判成字符串起点，进而把一条 CREATE TABLE 切成两半。
 *   故必须做词法扫描：注释优先于引号，引号内不识别注释，反引号内不识别引号。
 *
 * 设计：一次扫描产出「注释区间」与「顶层分号位置」，两个公开 API 共用同一份扫描结果，
 * 避免两套状态机各错一半。
 */

/** 注释区间（左闭右开）与顶层分号下标。 */
export interface SqlScan {
  readonly comments: ReadonlyArray<readonly [number, number]>;
  readonly boundaries: readonly number[];
}

const isWs = (ch: string): boolean =>
  ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v';

/**
 * 扫描 SQL 文本。
 * - 注释：`-- `（MySQL 要求 -- 后跟空白或行尾）、`#`、`/* ... *\/`
 * - 引号：`'...'`、`"..."`、`` `...` ``；支持反斜杠转义与「双写同种引号」转义
 * - 顶层分号：不在注释与引号内的 `;`
 */
export function scanSql(sql: string): SqlScan {
  const comments: Array<readonly [number, number]> = [];
  const boundaries: number[] = [];
  const n = sql.length;
  let i = 0;

  while (i < n) {
    const ch = sql[i] as string;
    const next = i + 1 < n ? (sql[i + 1] as string) : '';

    // ── 行注释：-- 后必须是空白/行尾（MySQL 语义），否则是减号运算符 ──
    if (ch === '-' && next === '-' && (i + 2 >= n || isWs(sql[i + 2] as string))) {
      const start = i;
      i += 2;
      while (i < n && sql[i] !== '\n') i += 1;
      comments.push([start, i]);
      continue;
    }
    if (ch === '#') {
      const start = i;
      i += 1;
      while (i < n && sql[i] !== '\n') i += 1;
      comments.push([start, i]);
      continue;
    }
    // ── 块注释（含 /*! ... */ 可执行注释：本基线未使用，统一按注释处理）──
    if (ch === '/' && next === '*') {
      const start = i;
      i += 2;
      while (i < n && !(sql[i] === '*' && i + 1 < n && sql[i + 1] === '/')) i += 1;
      i = i < n ? i + 2 : n; // 未闭合则吃到结尾
      comments.push([start, i]);
      continue;
    }
    // ── 引号：注释判定在前，故注释里的引号不会开启字符串 ──
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < n) {
        const cur = sql[i] as string;
        // 反斜杠转义对反引号标识符无效（MySQL 标识符里反斜杠是普通字符）
        if (cur === '\\' && quote !== '`') {
          i += 2;
          continue;
        }
        if (cur === quote) {
          if (i + 1 < n && sql[i + 1] === quote) {
            i += 2; // 双写转义
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (ch === ';') {
      boundaries.push(i);
      i += 1;
      continue;
    }
    i += 1;
  }

  return { comments, boundaries };
}

/** 把注释区间替换为等长空白，保持其余字符下标不变（便于定位与比对）。 */
export function stripSqlComments(sql: string): string {
  const { comments } = scanSql(sql);
  if (comments.length === 0) return sql;
  const chars = [...sql];
  for (const [start, end] of comments) {
    for (let k = start; k < end; k += 1) {
      // 保留换行，避免把两行代码粘成一行
      if (chars[k] !== '\n' && chars[k] !== '\r') chars[k] = ' ';
    }
  }
  return chars.join('');
}

/** 区间内是否存在「非注释且非空白」的真实代码。 */
function hasCode(sql: string, from: number, to: number, comments: ReadonlyArray<readonly [number, number]>): boolean {
  for (let i = from; i < to; i += 1) {
    const ch = sql[i] as string;
    if (isWs(ch)) continue;
    const inComment = comments.some(([s, e]) => i >= s && i < e);
    if (!inComment) return true;
  }
  return false;
}

/**
 * 切分为可逐条执行的语句。
 * - 返回**原文切片**（保留注释，保证发给 MySQL 的文本与架构 DDL 一致），去掉首尾空白与结尾分号
 * - 纯注释片段（如文件头、表与表之间的说明）被丢弃，不会当成空语句执行
 */
export function splitSqlStatements(sql: string): string[] {
  const { comments, boundaries } = scanSql(sql);
  const out: string[] = [];
  let from = 0;
  for (const b of boundaries) {
    if (hasCode(sql, from, b, comments)) {
      const text = sql.slice(from, b).trim();
      if (text.length > 0) out.push(text);
    }
    from = b + 1;
  }
  if (from < sql.length && hasCode(sql, from, sql.length, comments)) {
    const text = sql.slice(from).trim();
    if (text.length > 0) out.push(text);
  }
  return out;
}

/**
 * 从一条 CREATE TABLE 语句里取表名（先剥注释，避免注释中的同名词干扰）。
 * 不是 CREATE TABLE 则返回 null。
 */
export function createdTableName(statement: string): string | null {
  const code = stripSqlComments(statement);
  const m = /^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:`([^`]+)`|([A-Za-z_][A-Za-z0-9_$]*))/i.exec(code);
  if (m === null) return null;
  return m[1] ?? m[2] ?? null;
}