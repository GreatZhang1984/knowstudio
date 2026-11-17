/**
 * 迁移执行器 —— **文件账本**，刻意不用 Kysely 内置 Migrator。
 *
 * 为什么禁用内置 Migrator（客户 2026-11-13 拍板的硬不变量）：
 *   Kysely Migrator 会建 `kysely_migration` 与 `kysely_migration_lock` 两张表，
 *   36 张表立刻变成 38 张，直接破坏「恰好 36 张」的验收口径。
 *   会话/refresh token 存 Redis，同样不建会话表。
 *   故账本落在 `packages/db/migrations/.applied.json`，DB 里只有那 36 张业务表。
 *
 * 幂等性由两道保证叠加：
 *   1) 账本：同 id + 同 sha256 已记录 → 整个迁移跳过；
 *   2) 存在性：逐条 CREATE TABLE 前查 information_schema，表已存在 → 跳过该条。
 *   因此「账本丢了重跑」与「账本在重跑」都收敛到同一状态，不会报 already exists。
 *
 * 事务口径：MySQL 的 DDL 是**隐式提交**的，无法把 36 条 CREATE TABLE 包进一个事务。
 *   所以这里不假装原子，而是靠「逐条 + 存在性跳过」让中断后可安全续跑。
 *
 * 执行前必须过 `assertServerCapabilities`：低于 8.0.17 拒绝执行。
 *   CHECK 在 <8.0.16 被解析但忽略，超支兜底会静默失效——静默降级比报错危险得多。
 */
import { existsSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { Database } from '../src/schema/index.js';
import { assertServerCapabilities } from '../src/client.js';
import type { DbHandle, ServerCapabilities } from '../src/client.js';
import { createdTableName, splitSqlStatements } from './sql-split.js';
import { FORBIDDEN_TABLES, TABLE_ORDER, TOTAL_TABLE_COUNT } from './tables.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 默认迁移目录 = 本文件所在目录。 */
export const DEFAULT_MIGRATIONS_DIR = HERE;
/** 默认账本路径。 */
export const DEFAULT_LEDGER_PATH = path.join(HERE, '.applied.json');

export interface AppliedMigration {
  readonly id: string;
  readonly sha256: string;
  readonly appliedAt: string;
  readonly statementCount: number;
  readonly tablesCreated: readonly string[];
  readonly tablesSkipped: readonly string[];
}

export interface MigrationLedger {
  readonly version: 1;
  readonly migrations: readonly AppliedMigration[];
}

export class MigrationChecksumMismatchError extends Error {
  readonly code = 'MIGRATION_CHECKSUM_MISMATCH';
  constructor(
    readonly id: string,
    readonly recorded: string,
    readonly actual: string,
  ) {
    super(
      `迁移 ${id} 的内容已被修改（账本 sha256=${recorded}，磁盘 sha256=${actual}）。` +
        `已应用的迁移不可变更；请新增一个迁移文件，或显式重建账本。`,
    );
    this.name = 'MigrationChecksumMismatchError';
  }
}

export class SchemaInvariantError extends Error {
  readonly code = 'SCHEMA_INVARIANT_VIOLATION';
  constructor(readonly problems: readonly string[]) {
    super(`36 表硬不变量被破坏：\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'SchemaInvariantError';
  }
}

export class MigrationStatementError extends Error {
  readonly code = 'MIGRATION_STATEMENT_FAILED';
  constructor(
    readonly migrationId: string,
    readonly statementIndex: number,
    readonly tableName: string | null,
    override readonly cause: unknown,
  ) {
    super(`迁移 ${migrationId} 第 ${statementIndex + 1} 条语句执行失败（表 ${tableName ?? '未知'}）`);
    this.name = 'MigrationStatementError';
  }
}

/** 读账本；不存在则返回空账本（首次运行）。 */
export function readLedger(ledgerPath: string = DEFAULT_LEDGER_PATH): MigrationLedger {
  if (!existsSync(ledgerPath)) return { version: 1, migrations: [] };
  const parsed: unknown = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as { version?: unknown }).version !== 1 ||
    !Array.isArray((parsed as { migrations?: unknown }).migrations)
  ) {
    throw new Error(`账本格式不合法：${ledgerPath}`);
  }
  return parsed as MigrationLedger;
}

/** 原子写账本：先写 .tmp 再 rename；失败用 unlinkSync 清理（本机 rmSync 静默失败）。 */
export function writeLedger(ledger: MigrationLedger, ledgerPath: string = DEFAULT_LEDGER_PATH): void {
  const tmp = `${ledgerPath}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
    renameSync(tmp, ledgerPath);
  } catch (err) {
    if (existsSync(tmp)) unlinkSync(tmp);
    throw err;
  }
}

/** 列出迁移目录下的 .sql 文件，按文件名排序（0001_ 前缀即执行顺序）。 */
export function discoverMigrations(dir: string = DEFAULT_MIGRATIONS_DIR): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

/** 取库里真实存在的基表名（走 information_schema，不是 SHOW TABLES 的字符串解析）。 */
export async function listTables(db: Kysely<Database>, schema: string): Promise<string[]> {
  const { rows } = await sql<{ TABLE_NAME: string }>`
    SELECT TABLE_NAME
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = ${schema} AND TABLE_TYPE = 'BASE TABLE'
    ORDER BY TABLE_NAME
  `.execute(db);
  return rows.map((r) => r.TABLE_NAME);
}

/**
 * 校验 36 表不变量：数量、集合双向一致、无禁止表。
 * 单独导出，供测试与运维复核复用（不是只在迁移末尾偷偷跑一次）。
 */
export function assertSchemaInvariant(liveTables: readonly string[]): void {
  const problems: string[] = [];
  const live = new Set(liveTables);
  const expected = new Set<string>(TABLE_ORDER);

  if (liveTables.length !== TOTAL_TABLE_COUNT) {
    problems.push(`表数量为 ${liveTables.length}，要求恰好 ${TOTAL_TABLE_COUNT}`);
  }
  for (const t of TABLE_ORDER) {
    if (!live.has(t)) problems.push(`缺少表 ${t}`);
  }
  for (const t of liveTables) {
    if (!expected.has(t)) problems.push(`出现预期外的表 ${t}（不得有第 37 张）`);
  }
  for (const t of FORBIDDEN_TABLES) {
    if (live.has(t)) problems.push(`出现禁止表 ${t}（会话存 Redis；内置 Migrator 已禁用）`);
  }
  if (new Set(liveTables).size !== liveTables.length) {
    problems.push('表名存在重复');
  }
  if (problems.length > 0) throw new SchemaInvariantError(problems);
}

export interface MigrateOptions {
  readonly handle: DbHandle;
  readonly migrationsDir?: string;
  readonly ledgerPath?: string;
  /** 只算不执行：返回将要执行的语句数，不写账本、不发 DDL。 */
  readonly dryRun?: boolean;
}

export interface MigrateResult {
  readonly capabilities: ServerCapabilities;
  readonly applied: readonly AppliedMigration[];
  /** 账本命中而整体跳过的迁移 id。 */
  readonly skipped: readonly string[];
  readonly tables: readonly string[];
  readonly tableCount: number;
}

/** 执行迁移。任何一步不符口径都抛结构化错误，绝不静默降级。 */
export async function migrate(options: MigrateOptions): Promise<MigrateResult> {
  const { handle } = options;
  const dir = options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;
  const ledgerPath = options.ledgerPath ?? DEFAULT_LEDGER_PATH;
  const dryRun = options.dryRun ?? false;

  // ── 门禁①：连接初始化失败不静默吞掉 ──
  if (handle.initError !== null) throw handle.initError;
  // ── 门禁②：版本与会话参数（低于 8.0.17 直接拒绝） ──
  const capabilities = await assertServerCapabilities(handle.db);

  const ledger = readLedger(ledgerPath);
  const applied: AppliedMigration[] = [];
  const skipped: string[] = [];
  const entries: AppliedMigration[] = [...ledger.migrations];

  for (const file of discoverMigrations(dir)) {
    const id = file.replace(/\.sql$/, '');
    const text = readFileSync(path.join(dir, file), 'utf8');
    const sha256 = createHash('sha256').update(text, 'utf8').digest('hex');
    const statements = splitSqlStatements(text);

    const recorded = entries.find((m) => m.id === id);
    if (recorded !== undefined) {
      if (recorded.sha256 !== sha256) {
        throw new MigrationChecksumMismatchError(id, recorded.sha256, sha256);
      }
      skipped.push(id);
      continue;
    }

    const existing = new Set(await listTables(handle.db, handle.config.database));
    const created: string[] = [];
    const skippedTables: string[] = [];

    for (let i = 0; i < statements.length; i += 1) {
      const stmt = statements[i] as string;
      const table = createdTableName(stmt);
      if (table !== null && existing.has(table)) {
        skippedTables.push(table);
        continue;
      }
      if (!dryRun) {
        try {
          await sql.raw(stmt).execute(handle.db);
        } catch (cause) {
          throw new MigrationStatementError(id, i, table, cause);
        }
      }
      if (table !== null) {
        created.push(table);
        existing.add(table);
      }
    }

    const entry: AppliedMigration = {
      id,
      sha256,
      appliedAt: new Date().toISOString(),
      statementCount: statements.length,
      tablesCreated: created,
      tablesSkipped: skippedTables,
    };
    applied.push(entry);
    entries.push(entry);
  }

  const tables = await listTables(handle.db, handle.config.database);
  // dryRun 下库里可能还没建表，此时不做不变量断言（避免把「预演」误判成「破坏」）。
  if (!dryRun) assertSchemaInvariant(tables);

  if (!dryRun && applied.length > 0) {
    writeLedger({ version: 1, migrations: entries }, ledgerPath);
  }

  return { capabilities, applied, skipped, tables, tableCount: tables.length };
}