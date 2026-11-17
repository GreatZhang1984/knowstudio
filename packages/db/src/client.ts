/**
 * MySQL 连接层（架构 §4.3.2 / §4.3.6）。
 *
 * 口径固定：
 *   - Kysely `MysqlDialect` + `mysql2` 连接池，走 TCP。
 *   - 连接字符集 utf8mb4 / collation utf8mb4_0900_ai_ci，**连接级** time_zone='+00:00'。
 *     mysql2 的 `timezone` 选项只影响驱动侧的 Date 编解码，不会改服务端会话变量，
 *     因此额外在每条新连接上显式 `SET time_zone`，并用断言复核会话真实值。
 *   - `dateStrings: true`：DATETIME(3) 以 **UTC 字面量字符串**进出，杜绝驱动按本地时区
 *     隐式转换造成历史数据漂移（架构 §4.3.2 选 DATETIME 而非 TIMESTAMP 的理由）。
 *   - `supportBigNumbers + bigNumberStrings`：BIGINT 以 string 进出，避免 >2^53 静默丢精度。
 *   - DECIMAL 保持 string（mysql2 默认），**禁止浮点参与计费**。
 *   - `multipleStatements: false`：迁移逐条执行，杜绝一次提交多条 DDL 的半成功态。
 *
 * 迁移前必须调用 `assertServerCapabilities`：低于 8.0.17 直接拒绝执行。
 * 理由（架构 §4.3.1）：CHECK 在 <8.0.16 被解析但**忽略**，超支兜底会静默失效；
 * 多值索引需 8.0.17。静默降级比报错危险得多。
 */
import { Kysely, MysqlDialect, sql } from 'kysely';
import mysql from 'mysql2';
import type { Database } from './schema/index.js';

/** 架构 §4.3.1 的硬性下限：取 CHECK(8.0.16) / SKIP LOCKED(8.0.1) / 多值索引(8.0.17) 的最大值。 */
export const MIN_MYSQL_VERSION = '8.0.17';

export type MysqlPool = ReturnType<typeof mysql.createPool>;

/**
 * 内部连接参数（host/port/user/password/database 形态）。
 *
 * 命名说明：本接口原名 `DbConfig`。协调者 2026-11-13 冻结了跨包导出
 * `DbConfig { url; connectionLimit? }`（WP12 注册到 DI 令牌 DB_CLIENT），
 * 冻结名优先，故内部形态改名为 `DbConnectionConfig`。
 * 实测无任何外部包 import 过旧 `DbConfig` 类型（apps/api 仅在注释里提到），改名不破坏消费者；
 * `createDb({ connectionLimit })` 的调用形态保持不变。
 */
export interface DbConnectionConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
  readonly connectionLimit: number;
}

/**
 * **跨包冻结导出**（协调者 2026-11-13 新增）。签名逐字一致，不得改名/改形。
 * WP12 在 apps/api 里 `import { createDbClient } from '@knowstudio/db'`，
 * 注册到 DI 令牌 `DB_CLIENT`。
 *
 * `url` 形如 `mysql://knowstudio:knowstudio_app_dev_only@127.0.0.1:3306/knowstudio`。
 */
export interface DbConfig {
  url: string;
  connectionLimit?: number;
}

/**
 * 环境变量里的数值必须是**正整数**。
 * 空串会被 Number('') 变成 0 且「有限」，若只判 isFinite 就会得到 0 连接池（永久等待）
 * 或 port 0；故这里显式拒绝 0/负数/非整数/超范围，一律回退到安全默认。
 */
function positiveInt(raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0 || n > max) return fallback;
  return n;
}

/**
 * 默认值仅用于**本地 dev**（与 infra/docker-compose.yml 的基座一致）。
 * prod/staging 必须通过环境变量注入，不得依赖这里的字面量。
 */
export function dbConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DbConnectionConfig {
  return {
    host: env['KNOWSTUDIO_DB_HOST'] ?? '127.0.0.1',
    port: positiveInt(env['KNOWSTUDIO_DB_PORT'], 3306, 65535),
    user: env['KNOWSTUDIO_DB_USER'] ?? 'knowstudio',
    password: env['KNOWSTUDIO_DB_PASSWORD'] ?? 'knowstudio_app_dev_only',
    database: env['KNOWSTUDIO_DB_NAME'] ?? 'knowstudio',
    connectionLimit: positiveInt(env['KNOWSTUDIO_DB_POOL_SIZE'], 10, 1000),
  };
}

// ── 结构化错误：一律用 code 分支，禁止按 error.message 猜类型 ──────────────────

export interface VersionTriple {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

export class DbVersionParseError extends Error {
  readonly code = 'DB_VERSION_PARSE_FAILED';
  constructor(readonly raw: string) {
    super(`无法解析 MySQL VERSION() 返回值：${JSON.stringify(raw)}`);
    this.name = 'DbVersionParseError';
  }
}

export class DbVersionUnsupportedError extends Error {
  readonly code = 'DB_VERSION_UNSUPPORTED';
  constructor(
    readonly actual: string,
    readonly required: string,
    readonly reason: string,
  ) {
    super(`MySQL 版本不满足硬性下限：实际 ${actual}，要求 >= ${required}。${reason}`);
    this.name = 'DbVersionUnsupportedError';
  }
}

export interface CapabilityViolation {
  readonly key: string;
  readonly actual: string | number;
  readonly expected: string;
  readonly why: string;
}

export class DbConfigMismatchError extends Error {
  readonly code = 'DB_CONFIG_MISMATCH';
  constructor(readonly violations: readonly CapabilityViolation[]) {
    super(
      `MySQL 会话/实例参数不符合架构 §4.3 口径，拒绝启动（不静默降级）：\n` +
        violations.map((v) => `  - ${v.key}: 实际 ${String(v.actual)}，要求 ${v.expected}（${v.why}）`).join('\n'),
    );
    this.name = 'DbConfigMismatchError';
  }
}

export class DbConnectionInitError extends Error {
  readonly code = 'DB_CONNECTION_INIT_FAILED';
  constructor(override readonly cause: unknown) {
    super('新连接的会话初始化（SET NAMES / SET time_zone）失败');
    this.name = 'DbConnectionInitError';
  }
}

/** 解析 `8.4.13` / `8.0.17-log` / `8.4.13-0ubuntu1` 等形态，只取前三段数字。 */
export function parseMysqlVersion(raw: string): VersionTriple {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(raw.trim());
  if (m === null) throw new DbVersionParseError(raw);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** a<b → -1；a==b → 0；a>b → 1。 */
export function compareVersion(a: VersionTriple, b: VersionTriple): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}

export interface ServerCapabilities {
  readonly version: string;
  readonly sqlMode: string;
  readonly transactionIsolation: string;
  readonly ngramTokenSize: number;
  readonly timeZone: string;
  readonly characterSetServer: string;
  readonly collationServer: string;
  readonly characterSetClient: string;
  readonly collationConnection: string;
  readonly innodbLockWaitTimeout: number;
}

interface CapabilitiesRow {
  version: string;
  sql_mode: string;
  transaction_isolation: string;
  ngram_token_size: number;
  time_zone: string;
  character_set_server: string;
  collation_server: string;
  character_set_client: string;
  collation_connection: string;
  innodb_lock_wait_timeout: number;
}

/** 读取服务端与会话真实参数（不是读配置，是读 @@ 变量）。 */
export async function readServerCapabilities(db: Kysely<Database>): Promise<ServerCapabilities> {
  const { rows } = await sql<CapabilitiesRow>`
    SELECT VERSION()                    AS version,
           @@sql_mode                   AS sql_mode,
           @@transaction_isolation      AS transaction_isolation,
           @@ngram_token_size           AS ngram_token_size,
           @@time_zone                  AS time_zone,
           @@character_set_server       AS character_set_server,
           @@collation_server           AS collation_server,
           @@character_set_client       AS character_set_client,
           @@collation_connection       AS collation_connection,
           @@innodb_lock_wait_timeout   AS innodb_lock_wait_timeout
  `.execute(db);
  const row = rows[0];
  if (row === undefined) throw new Error('SELECT VERSION() 未返回任何行');
  return {
    version: row.version,
    sqlMode: row.sql_mode,
    transactionIsolation: row.transaction_isolation,
    ngramTokenSize: Number(row.ngram_token_size),
    timeZone: row.time_zone,
    characterSetServer: row.character_set_server,
    collationServer: row.collation_server,
    characterSetClient: row.character_set_client,
    collationConnection: row.collation_connection,
    innodbLockWaitTimeout: Number(row.innodb_lock_wait_timeout),
  };
}

/** 允许的隔离级别：架构 §4.3.6 默认 RR，配额/队列事务显式降 RC；实例整体设 RC 亦可。 */
const ALLOWED_ISOLATION = ['READ-COMMITTED', 'REPEATABLE-READ'];

/**
 * fail-fast 门禁（纯函数，便于对「低版本必须拒绝」做单元级负向验证）。
 * 版本不足抛 DbVersionUnsupportedError；
 * 其余口径不符汇总成 DbConfigMismatchError（一次报全，便于运维一轮修完）。
 */
export function checkCapabilities(caps: ServerCapabilities): ServerCapabilities {
  // MariaDB 的 VERSION() 形如 11.4.2-MariaDB，数字上会「通过」8.0.17 比较，
  // 但它没有 ngram parser 与多值索引，必须显式拒绝而不是靠后续断言兜底。
  if (/mariadb/i.test(caps.version)) {
    throw new DbVersionUnsupportedError(caps.version, `MySQL >= ${MIN_MYSQL_VERSION}`, '检测到 MariaDB，不是 MySQL 8');
  }

  const actual = parseMysqlVersion(caps.version);
  const required = parseMysqlVersion(MIN_MYSQL_VERSION);
  if (compareVersion(actual, required) < 0) {
    throw new DbVersionUnsupportedError(
      caps.version,
      MIN_MYSQL_VERSION,
      'CHECK 在 <8.0.16 被解析但忽略（超支兜底静默失效），多值索引需 >=8.0.17',
    );
  }

  const violations: CapabilityViolation[] = [];
  const push = (key: string, actualValue: string | number, expected: string, why: string): void => {
    violations.push({ key, actual: actualValue, expected, why });
  };

  if (!caps.sqlMode.split(',').includes('STRICT_TRANS_TABLES')) {
    push('sql_mode', caps.sqlMode, '含 STRICT_TRANS_TABLES', '拒绝静默截断，数据不被悄悄改坏');
  }
  if (caps.ngramTokenSize !== 2) {
    push('ngram_token_size', caps.ngramTokenSize, '2', '中文双字切分；实例级只读参数，改动需重启');
  }
  if (!ALLOWED_ISOLATION.includes(caps.transactionIsolation)) {
    push('transaction_isolation', caps.transactionIsolation, ALLOWED_ISOLATION.join(' | '), '配额/队列事务口径');
  }
  if (caps.timeZone !== '+00:00') {
    push('time_zone', caps.timeZone, '+00:00', 'DATETIME(3) 存 UTC，读写同一口径');
  }
  if (caps.characterSetClient !== 'utf8mb4') {
    push('character_set_client', caps.characterSetClient, 'utf8mb4', '中文与 emoji 不截断');
  }
  if (caps.collationConnection !== 'utf8mb4_0900_ai_ci') {
    push('collation_connection', caps.collationConnection, 'utf8mb4_0900_ai_ci', 'FK 两端 collation 必须一致，否则 errno 3780');
  }
  if (caps.characterSetServer !== 'utf8mb4') {
    push('character_set_server', caps.characterSetServer, 'utf8mb4', '库/表/列三级统一');
  }
  if (caps.collationServer !== 'utf8mb4_0900_ai_ci') {
    push('collation_server', caps.collationServer, 'utf8mb4_0900_ai_ci', '库/表/列三级统一');
  }

  if (violations.length > 0) throw new DbConfigMismatchError(violations);
  return caps;
}

/** 读服务端/会话真实 @@ 变量后立即过门禁。迁移与启动前必须调用。 */
export async function assertServerCapabilities(db: Kysely<Database>): Promise<ServerCapabilities> {
  return checkCapabilities(await readServerCapabilities(db));
}

export interface DbHandle {
  readonly db: Kysely<Database>;
  readonly pool: MysqlPool;
  readonly config: DbConnectionConfig;
  /** 新连接初始化失败时记录在此，供门禁一并报错（不静默吞掉）。 */
  readonly initError: DbConnectionInitError | null;
  destroy(): Promise<void>;
}

/**
 * 建连接池 + Kysely 实例。
 * 每条新连接显式钉住 charset/collation 与会话时区；失败不吞，记录到 initError。
 */
export function createDb(overrides: Partial<DbConnectionConfig> = {}): DbHandle {
  const config: DbConnectionConfig = { ...dbConfigFromEnv(), ...overrides };
  const pool = mysql.createPool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    connectionLimit: config.connectionLimit,
    waitForConnections: true,
    charset: 'utf8mb4',
    timezone: '+00:00',
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    multipleStatements: false,
    enableKeepAlive: true,
  });

  let initError: DbConnectionInitError | null = null;
  pool.on('connection', (conn) => {
    conn.query('SET NAMES utf8mb4 COLLATE utf8mb4_0900_ai_ci', (err) => {
      if (err != null) initError = new DbConnectionInitError(err);
    });
    conn.query("SET time_zone = '+00:00'", (err) => {
      if (err != null) initError = new DbConnectionInitError(err);
    });
  });

  const db = new Kysely<Database>({ dialect: new MysqlDialect({ pool }) });

  return {
    db,
    pool,
    config,
    get initError() {
      return initError;
    },
    async destroy() {
      await db.destroy();
    },
  };
}

// ── 跨包冻结工厂：createDbClient(config: DbConfig): Kysely<Database> ──────────────
// 协调者 2026-11-13 新增。WP12 在 apps/api 里 import 后注册到 DI 令牌 DB_CLIENT。
// 签名逐字冻结：不得改名、不得改成 async、不得返回 DbHandle。

/** 配置非法的结构化原因（一律按 code/field/problem 分支，禁止按 message 猜）。 */
export type DbConfigProblem =
  | 'malformed'
  | 'protocol'
  | 'query'
  | 'fragment'
  | 'user'
  | 'host'
  | 'port'
  | 'database'
  | 'encoding'
  | 'not-positive-int'
  | 'too-large';

export class DbClientConfigError extends Error {
  readonly code = 'DB_CLIENT_CONFIG_INVALID';
  constructor(
    readonly field: 'url' | 'connectionLimit',
    readonly problem: DbConfigProblem,
    readonly detail: string,
  ) {
    super(`createDbClient 配置非法：${field} [${problem}] —— ${detail}`);
    this.name = 'DbClientConfigError';
  }
}

/** 连接池上限：与 dbConfigFromEnv 的 env 校验保持同一口径。 */
const MAX_CONNECTION_LIMIT = 1000;

function decodePart(raw: string, field: 'user' | 'host' | 'database'): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new DbClientConfigError('url', 'encoding', `${field} 含非法百分号转义：${JSON.stringify(raw)}`);
  }
}

/**
 * 解析 `mysql://user:pass@host:port/database`（纯函数，可单测）。
 *
 * 严格拒绝而不是静默兜底，理由：
 *   - 非 mysql:// 协议：连到别的引擎会静默走错方言。
 *   - 带 query/fragment：`?ssl=...` 之类选项若被悄悄丢弃，等于静默降级安全口径。
 *   - 缺库名/多段路径：连到错误的库比连不上更危险。
 * 端口缺省 3306；密码允许为空（本地 dev）；IPv6 去掉 WHATWG URL 带的方括号。
 */
export function parseDbUrl(url: string): Omit<DbConnectionConfig, 'connectionLimit'> {
  if (typeof url !== 'string' || url.trim() === '') {
    throw new DbClientConfigError('url', 'malformed', 'url 必须是非空字符串');
  }
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new DbClientConfigError('url', 'malformed', `无法按 URL 语法解析：${JSON.stringify(url)}`);
  }
  if (u.protocol !== 'mysql:') {
    throw new DbClientConfigError('url', 'protocol', `只支持 mysql://，实际 ${u.protocol}`);
  }
  if (u.search !== '') {
    throw new DbClientConfigError('url', 'query', `不接受查询串（选项会被静默丢弃）：${u.search}`);
  }
  if (u.hash !== '') {
    throw new DbClientConfigError('url', 'fragment', `不接受 fragment：${u.hash}`);
  }
  // 先校验 authority 的结构（host），再校验凭据（user）：
  // `mysql:///db` 这种「整个 authority 都缺」的 URL，报缺主机比报缺用户名更有诊断价值；
  // 且这样两条分支各自可达、各自有负向用例覆盖（缺 host 与缺 user 不会互相遮蔽）。
  const rawHost = u.hostname;
  const host = rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost;
  if (host === '') throw new DbClientConfigError('url', 'host', '缺少主机名');
  const user = decodePart(u.username, 'user');
  if (user === '') throw new DbClientConfigError('url', 'user', '缺少用户名');
  const password = decodePart(u.password, 'user');
  const port = u.port === '' ? 3306 : Number(u.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new DbClientConfigError('url', 'port', `端口必须是 1..65535 的整数，实际 ${u.port}`);
  }
  const database = decodePart(u.pathname.startsWith('/') ? u.pathname.slice(1) : u.pathname, 'database');
  if (database === '' || database.includes('/')) {
    throw new DbClientConfigError('url', 'database', `必须恰好一个库名，实际路径 ${u.pathname}`);
  }
  return { host, port, user, password, database };
}

/**
 * 显式传入的 connectionLimit 非法时**抛错**，不像 env 那样静默回退：
 * env 是运维输入、需要容错启动；这里是代码传参，写错了必须立刻暴露。
 */
function resolveConnectionLimit(raw: number | undefined): number {
  if (raw === undefined) return dbConfigFromEnv().connectionLimit;
  if (!Number.isFinite(raw) || !Number.isInteger(raw) || raw <= 0) {
    throw new DbClientConfigError('connectionLimit', 'not-positive-int', `必须是正整数，实际 ${String(raw)}`);
  }
  if (raw > MAX_CONNECTION_LIMIT) {
    throw new DbClientConfigError('connectionLimit', 'too-large', `不得超过 ${String(MAX_CONNECTION_LIMIT)}，实际 ${String(raw)}`);
  }
  return raw;
}

/**
 * 冻结签名保留的是 `Kysely<Database>`，拿不到 DbHandle.initError。
 * 用 WeakMap 旁挂原 handle，既不改变冻结签名，也不把「新连接初始化失败」这条错误通道静默丢掉；
 * 不持有强引用，db 被回收后条目自动消失。
 */
const CLIENT_HANDLES = new WeakMap<Kysely<Database>, DbHandle>();

/** 取回 createDbClient 内部的 DbHandle（含 initError / pool / config）；非本工厂产物返回 undefined。 */
export function dbHandleOf(db: Kysely<Database>): DbHandle | undefined {
  return CLIENT_HANDLES.get(db);
}

/**
 * **跨包冻结导出**：由 URL 建 mysql2 连接池并返回 Kysely 实例。
 *
 * 口径（与 createDb 完全一致，不另起一套）：
 *   - mysql2 驱动 + Kysely MysqlDialect，走 TCP；
 *   - charset utf8mb4 / collation utf8mb4_0900_ai_ci，每条新连接显式 SET NAMES；
 *   - 会话 time_zone='+00:00'（驱动 timezone 只管 Date 编解码，不改服务端会话变量）；
 *   - dateStrings / supportBigNumbers / bigNumberStrings / multipleStatements:false 同 createDb。
 *
 * **隔离级别不在客户端设置**：服务端已实测为 READ-COMMITTED，客户端反着设会与服务端口径打架。
 * 调用方在使用/迁移前必须 `await assertServerCapabilities(db)` 过门禁（版本下限 8.0.17、
 * ngram_token_size=2、time_zone、字符集与排序规则、隔离级别）。
 *
 * 生命周期：`await db.destroy()` 即关闭底层连接池（Kysely → MysqlDialect → pool.end）。
 */
export function createDbClient(config: DbConfig): Kysely<Database> {
  const parsed = parseDbUrl(config.url);
  const connectionLimit = resolveConnectionLimit(config.connectionLimit);
  const handle = createDb({ ...parsed, connectionLimit });
  CLIENT_HANDLES.set(handle.db, handle);
  return handle.db;
}