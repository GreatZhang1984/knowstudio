/**
 * `@knowstudio/db` 公共出口。
 *
 * 分层：
 *   - 连接与门禁：createDb / assertServerCapabilities（迁移前 fail-fast）
 *   - 跨包冻结入口：createDbClient(config: DbConfig): Kysely<Database>
 *     （协调者 2026-11-13 冻结；WP12 在 apps/api 注册到 DI 令牌 DB_CLIENT）
 *   - 类型：Database 与 36 张表的列类型（仓储层 WP11 据此写查询）
 *   - 迁移：文件账本 migrate（**不含** Kysely 内置 Migrator，保住 36 表不变量）
 *   - 种子：applySeed（SPEC §4.3 的 3/10/12/212 字/60-22）
 *
 * 本包不提供任何平台发布写接口（G5）：只有业务表读写，没有 publish 适配器。
 */
export {
  MIN_MYSQL_VERSION,
  DbClientConfigError,
  DbConfigMismatchError,
  DbConnectionInitError,
  DbVersionParseError,
  DbVersionUnsupportedError,
  assertServerCapabilities,
  checkCapabilities,
  compareVersion,
  createDb,
  createDbClient,
  dbConfigFromEnv,
  dbHandleOf,
  parseDbUrl,
  parseMysqlVersion,
  readServerCapabilities,
  type CapabilityViolation,
  type DbConfig,
  type DbConfigProblem,
  type DbConnectionConfig,
  type DbHandle,
  type MysqlPool,
  type ServerCapabilities,
  type VersionTriple,
} from './client.js';

export * from './schema/index.js';
export { toJsonParam } from './schema/column-types.js';

/**
 * 跨包冻结：`Database` 必须从本入口可 import（WP12 的 DB_CLIENT 令牌类型即 Kysely<Database>）。
 * 上面的 `export *` 已带出它，这里再显式列出，避免任何人改动 schema 出口时把冻结契约悄悄弄丢。
 */
export type { Database } from './schema/index.js';
export type { Kysely, Transaction } from 'kysely';

export {
  DEFAULT_LEDGER_PATH,
  DEFAULT_MIGRATIONS_DIR,
  MigrationChecksumMismatchError,
  MigrationStatementError,
  SchemaInvariantError,
  assertSchemaInvariant,
  discoverMigrations,
  listTables,
  migrate,
  readLedger,
  writeLedger,
  type AppliedMigration,
  type MigrateOptions,
  type MigrateResult,
  type MigrationLedger,
} from '../migrations/runner.js';

export {
  ENTITY_TABLES,
  ENTITY_TABLE_COUNT,
  FORBIDDEN_TABLES,
  SUPPORT_TABLES,
  SUPPORT_TABLE_COUNT,
  TABLE_ORDER,
  TOTAL_TABLE_COUNT,
  type TableName,
} from '../migrations/tables.js';

export {
  createdTableName,
  scanSql,
  splitSqlStatements,
  stripSqlComments,
  type SqlScan,
} from '../migrations/sql-split.js';

export {
  SEED_EXPECTATIONS,
  SeedInvariantError,
  applySeed,
  loadSeedData,
  measureSeedCounts,
  seedId,
  utcLiteral,
  validateSeedData,
  type ApplySeedOptions,
  type SeedCounts,
  type SeedData,
  type SeedResult,
} from '../migrations/seed.js';

export {
  canonicalExpr,
  compareAll,
  compareTable,
  lex,
  parseCreateTable,
  parseShowCreateDump,
  stripAutoIncrementCounter,
  type ColumnShape,
  type CompareReport,
  type ForeignKeyShape,
  type TableDiff,
  type TableShape,
} from '../migrations/ddl-compare.js';
