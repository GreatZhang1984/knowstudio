/**
 * 36 表硬不变量测试（客户 2026-11-13 拍板：恰好 36，不得有第 37 张）。
 *
 * 三层防线都测：
 *   1) 清单自身：24 实体 + 12 支撑 = 36，无重复，禁止表不相交
 *   2) 编译期：Database 的键集合与 TABLE_ORDER **双向**相等
 *   3) 运行期：assertSchemaInvariant 对少表/多表/禁止表/重复必须抛错
 *
 * 编译期检查附**类型级负向断言**：故意少一张/多一张表时必须判为 false，
 * 以此证明相等性检查不是恒真的装饰。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ENTITY_TABLES,
  ENTITY_TABLE_COUNT,
  FORBIDDEN_TABLES,
  SUPPORT_TABLES,
  SUPPORT_TABLE_COUNT,
  TABLE_ORDER,
  TOTAL_TABLE_COUNT,
} from '../migrations/tables.js';
import type { TableName } from '../migrations/tables.js';
import { SchemaInvariantError, assertSchemaInvariant } from '../migrations/runner.js';
import { createdTableName, splitSqlStatements } from '../migrations/sql-split.js';
import type { Database } from '../src/schema/index.js';

// ── 编译期双向一致性 ──────────────────────────────────────────────────────────

type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type AssertTrue<T extends true> = T;

/** Database 的键必须与 TABLE_ORDER 完全一致：少一张或多一张都编译不过。 */
export type SchemaKeysMatchTableOrder = AssertTrue<Equal<keyof Database, TableName>>;

/** 负向①：少一张表必须被判为不等（证明上面的检查有鉴别力）。 */
export type MissingTableIsDetected = AssertTrue<Equal<Equal<keyof Omit<Database, 'app_user'>, TableName>, false>>;

/** 负向②：多一张禁止表必须被判为不等。 */
export type ExtraTableIsDetected = AssertTrue<
  Equal<Equal<keyof (Database & { kysely_migration: { id: string } }), TableName>, false>
>;

const baseline = readFileSync(
  fileURLToPath(new URL('../migrations/0001_baseline.sql', import.meta.url)),
  'utf8',
);
const baselineNames = splitSqlStatements(baseline).map((s) => createdTableName(s) as string);

describe('表清单自身', () => {
  it('恰好 36 张', () => {
    expect(TABLE_ORDER).toHaveLength(TOTAL_TABLE_COUNT);
    expect(TOTAL_TABLE_COUNT).toBe(36);
  });

  it('24 实体 + 12 支撑 = 36（架构 §16 口径）', () => {
    expect(ENTITY_TABLE_COUNT).toBe(24);
    expect(SUPPORT_TABLE_COUNT).toBe(12);
    expect(ENTITY_TABLE_COUNT + SUPPORT_TABLE_COUNT).toBe(TOTAL_TABLE_COUNT);
    expect(ENTITY_TABLES).toHaveLength(ENTITY_TABLE_COUNT);
    expect(SUPPORT_TABLES).toHaveLength(SUPPORT_TABLE_COUNT);
  });

  it('无重复表名', () => {
    expect(new Set(TABLE_ORDER).size).toBe(TABLE_ORDER.length);
    expect(new Set(SUPPORT_TABLES).size).toBe(SUPPORT_TABLES.length);
  });

  it('支撑表是总表的子集，实体表由集合运算得出且与支撑表不相交', () => {
    const all = new Set<string>(TABLE_ORDER);
    for (const t of SUPPORT_TABLES) expect(all.has(t)).toBe(true);
    const support = new Set<string>(SUPPORT_TABLES);
    for (const t of ENTITY_TABLES) expect(support.has(t)).toBe(false);
    expect([...ENTITY_TABLES, ...SUPPORT_TABLES].sort()).toEqual([...TABLE_ORDER].sort());
  });

  it('禁止表与 36 张表不相交（会话存 Redis，不建会话表）', () => {
    const all = new Set<string>(TABLE_ORDER);
    for (const t of FORBIDDEN_TABLES) expect(all.has(t)).toBe(false);
  });

  it('禁止表覆盖内置 Migrator 账本表与会话/refresh token 表', () => {
    expect(FORBIDDEN_TABLES).toContain('kysely_migration');
    expect(FORBIDDEN_TABLES).toContain('kysely_migration_lock');
    expect(FORBIDDEN_TABLES.some((t) => t.includes('session'))).toBe(true);
    expect(FORBIDDEN_TABLES.some((t) => t.includes('refresh_token'))).toBe(true);
  });

  it('清单与基线 DDL 解析出的表名双向一致', () => {
    expect(baselineNames).toHaveLength(TOTAL_TABLE_COUNT);
    expect([...baselineNames].sort()).toEqual([...TABLE_ORDER].sort());
  });
});

describe('assertSchemaInvariant · 运行期门禁', () => {
  it('接受恰好 36 张的正确集合', () => {
    expect(() => assertSchemaInvariant([...TABLE_ORDER])).not.toThrow();
  });

  it('顺序无关（information_schema 按名排序返回）', () => {
    expect(() => assertSchemaInvariant([...TABLE_ORDER].sort())).not.toThrow();
  });

  const expectViolation = (tables: readonly string[], fragment: string): void => {
    let caught: unknown;
    try {
      assertSchemaInvariant(tables);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SchemaInvariantError);
    const err = caught as SchemaInvariantError;
    expect(err.code).toBe('SCHEMA_INVARIANT_VIOLATION');
    expect(err.problems.join('\n')).toContain(fragment);
  };

  it('35 张（少一张）必须拒绝', () => {
    expectViolation(TABLE_ORDER.slice(1), '表数量为 35');
    expectViolation(TABLE_ORDER.slice(1), '缺少表 app_user');
  });

  it('37 张（多一张）必须拒绝——这是客户硬约束的核心', () => {
    expectViolation([...TABLE_ORDER, 'extra_table'], '表数量为 37');
    expectViolation([...TABLE_ORDER, 'extra_table'], '不得有第 37 张');
  });

  it('出现 kysely_migration 必须拒绝（内置 Migrator 被禁用的理由）', () => {
    const tables = [...TABLE_ORDER.slice(0, 35), 'kysely_migration'];
    expectViolation(tables, '禁止表 kysely_migration');
  });

  it('出现 session 表必须拒绝（会话存 Redis）', () => {
    expectViolation([...TABLE_ORDER, 'session'], '禁止表 session');
  });

  it('表名重复必须拒绝', () => {
    expectViolation([...TABLE_ORDER.slice(0, 35), TABLE_ORDER[0] as string], '表名存在重复');
  });

  it('空库必须拒绝', () => {
    expectViolation([], '表数量为 0');
  });

  it('一次报全所有问题，不是只报第一条', () => {
    let caught: unknown;
    try {
      assertSchemaInvariant(['app_user', 'session']);
    } catch (err) {
      caught = err;
    }
    const problems = (caught as SchemaInvariantError).problems;
    expect(problems.length).toBeGreaterThan(2);
    expect(problems.join('\n')).toContain('禁止表 session');
    expect(problems.join('\n')).toContain('缺少表 work');
  });
});