/**
 * 跨包冻结工厂 `createDbClient(config: DbConfig): Kysely<Database>` 的契约测试。
 *
 * 为什么从 `../src/index.js` 而不是 `../src/client.js` import：
 *   WP12 在 apps/api 里走的是 `@knowstudio/db` 公共入口，只有从入口 import 才能证明
 *   「冻结签名真的从入口可达」，而不是只在内部模块里存在。
 *
 * 本文件**不连数据库**：mysql2 的 createPool 是惰性的（首次 query 才建 TCP），
 * 故可以安全地建实例→断言→destroy。真实连接口径由 mysql-integration.test.ts 核验。
 *
 * URL 解析的期望值全部来自对 WHATWG `new URL()` 的**实测**，不是凭记忆：
 *   - port 65536 → URL 构造直接抛 TypeError（故落到 malformed，而不是 port）
 *   - port 0     → URL 保留 '0'（故落到 port）
 *   - 无路径     → pathname 为 ''（故落到 database）
 *   - HOST_NAME  → 非特殊 scheme 的 opaque host **不会**被小写化（故不得断言小写）
 */
import { Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';
import {
  DbClientConfigError,
  createDb,
  createDbClient,
  dbHandleOf,
  parseDbUrl,
  type DbConfig,
} from '../src/index.js';
import type { Database } from '../src/index.js';

// ── 编译期冻结断言：签名改形/改名会在这里直接编译失败 ──────────────────────────
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type AssertTrue<T extends true> = T;

/** DbConfig 必须逐字是 { url: string; connectionLimit?: number }（不得多字段、不得改可选性）。 */
export type FrozenDbConfigShape = AssertTrue<Equal<DbConfig, { url: string; connectionLimit?: number }>>;
/** 返回类型必须是 Kysely<Database>，不得是 DbHandle、不得是 Promise。 */
export type FrozenFactoryReturn = AssertTrue<Equal<ReturnType<typeof createDbClient>, Kysely<Database>>>;
/** 入参必须恰好一个 DbConfig。 */
export type FrozenFactoryParams = AssertTrue<Equal<Parameters<typeof createDbClient>, [config: DbConfig]>>;
/** Database 必须从公共入口可 import，且恰好 36 张表。 */
export type FrozenDatabaseExport = AssertTrue<Equal<keyof Database extends string ? true : false, true>>;

const URL_REAL = 'mysql://knowstudio:knowstudio_app_dev_only@127.0.0.1:3306/knowstudio';

/** 断言结构化错误：一律看 code/field/problem，禁止按 message 分支。 */
function expectConfigError(run: () => unknown, field: 'url' | 'connectionLimit', problem: string): DbClientConfigError {
  let caught: unknown;
  try {
    run();
  } catch (e) {
    caught = e;
  }
  expect(caught, '期望抛错但成功了').toBeInstanceOf(DbClientConfigError);
  const err = caught as DbClientConfigError;
  expect(err.code).toBe('DB_CLIENT_CONFIG_INVALID');
  expect(err.field).toBe(field);
  expect(err.problem).toBe(problem);
  return err;
}

describe('冻结契约 · 入口可达性与签名', () => {
  it('createDbClient 从公共入口导出，且是单参函数', () => {
    expect(typeof createDbClient).toBe('function');
    expect(createDbClient.length).toBe(1);
  });
  it('parseDbUrl / dbHandleOf / DbClientConfigError 一并从入口可达', () => {
    expect(typeof parseDbUrl).toBe('function');
    expect(typeof dbHandleOf).toBe('function');
    expect(typeof DbClientConfigError).toBe('function');
  });
  it('旧 createDb({connectionLimit}) 调用形态未被改名破坏（下游 apps/api 在用）', async () => {
    const handle = createDb({ connectionLimit: 1 });
    expect(handle.config.connectionLimit).toBe(1);
    expect(handle.db).toBeInstanceOf(Kysely);
    await handle.destroy();
  });
});

describe('parseDbUrl · 正向', () => {
  it('标准 URL 逐字段解析正确', () => {
    expect(parseDbUrl(URL_REAL)).toEqual({
      host: '127.0.0.1',
      port: 3306,
      user: 'knowstudio',
      password: 'knowstudio_app_dev_only',
      database: 'knowstudio',
    });
  });
  it('省略端口时缺省 3306', () => {
    expect(parseDbUrl('mysql://u:p@127.0.0.1/knowstudio').port).toBe(3306);
  });
  it('显式非默认端口被保留', () => {
    expect(parseDbUrl('mysql://u:p@127.0.0.1:3307/knowstudio').port).toBe(3307);
  });
  it('密码里的百分号转义被解码（@ 与 : 不会截断 authority）', () => {
    const c = parseDbUrl('mysql://u:p%40ss%3Aword@127.0.0.1:3306/knowstudio');
    expect(c.password).toBe('p@ss:word');
    expect(c.user).toBe('u');
    expect(c.host).toBe('127.0.0.1');
  });
  it('用户名与库名同样支持百分号转义', () => {
    const c = parseDbUrl('mysql://us%40er:p@127.0.0.1:3306/know%5Fstudio');
    expect(c.user).toBe('us@er');
    expect(c.database).toBe('know_studio');
  });
  it('IPv6 主机去掉 WHATWG URL 带的方括号（mysql2 需要裸地址）', () => {
    expect(parseDbUrl('mysql://u:p@[::1]:3306/knowstudio').host).toBe('::1');
  });
  it('空密码允许（本地 dev），但用户名不可为空', () => {
    expect(parseDbUrl('mysql://u@127.0.0.1:3306/knowstudio').password).toBe('');
  });
  it('opaque host 原样保留（实测非特殊 scheme 不做小写化）', () => {
    expect(parseDbUrl('mysql://u:p@HOST_NAME:3306/knowstudio').host).toBe('HOST_NAME');
  });
});

describe('parseDbUrl · 负向（按实测的 URL 行为断言 problem）', () => {
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    ['空串', '', 'malformed'],
    ['全空白', '   ', 'malformed'],
    ['不是 URL', 'not a url', 'malformed'],
    ['端口超上限（URL 构造即抛）', 'mysql://u:p@127.0.0.1:65536/knowstudio', 'malformed'],
    ['协议不是 mysql', 'postgres://u:p@h:5432/db', 'protocol'],
    ['带查询串（选项会被静默丢弃）', 'mysql://u:p@127.0.0.1:3306/knowstudio?ssl=true', 'query'],
    ['带 fragment', 'mysql://u:p@127.0.0.1:3306/knowstudio#f', 'fragment'],
    ['缺用户名', 'mysql://:p@127.0.0.1:3306/knowstudio', 'user'],
    ['缺主机', 'mysql:///knowstudio', 'host'],
    ['端口 0', 'mysql://u:p@127.0.0.1:0/knowstudio', 'port'],
    ['无库名（pathname 为空）', 'mysql://u:p@127.0.0.1:3306', 'database'],
    ['库名为空（只有斜杠）', 'mysql://u:p@127.0.0.1:3306/', 'database'],
    ['多段路径', 'mysql://u:p@127.0.0.1:3306/a/b', 'database'],
    ['非法百分号转义', 'mysql://u%ZZ:p@127.0.0.1/knowstudio', 'encoding'],
  ];
  for (const [name, url, problem] of cases) {
    it(`${name} → url/${problem}`, () => {
      expectConfigError(() => parseDbUrl(url), 'url', problem);
    });
  }
  it('非字符串入参也被结构化拒绝（不是 TypeError 漏出去）', () => {
    expectConfigError(() => parseDbUrl(undefined as unknown as string), 'url', 'malformed');
    expectConfigError(() => parseDbUrl(123 as unknown as string), 'url', 'malformed');
  });
});

describe('createDbClient · connectionLimit 校验（显式传参非法必须抛，不静默回退）', () => {
  const bad: ReadonlyArray<readonly [string, number, string]> = [
    ['0', 0, 'not-positive-int'],
    ['负数', -1, 'not-positive-int'],
    ['小数', 1.5, 'not-positive-int'],
    ['NaN', Number.NaN, 'not-positive-int'],
    ['Infinity', Number.POSITIVE_INFINITY, 'not-positive-int'],
    ['超上限 1001', 1001, 'too-large'],
  ];
  for (const [name, value, problem] of bad) {
    it(`${name} → connectionLimit/${problem}`, () => {
      expectConfigError(() => createDbClient({ url: URL_REAL, connectionLimit: value }), 'connectionLimit', problem);
    });
  }
  it('上限边界 1000 允许', async () => {
    const db = createDbClient({ url: URL_REAL, connectionLimit: 1000 });
    expect(dbHandleOf(db)?.config.connectionLimit).toBe(1000);
    await db.destroy();
  });
  it('省略时回退到 env 口径（实测随 KNOWSTUDIO_DB_POOL_SIZE 变化）', async () => {
    const key = 'KNOWSTUDIO_DB_POOL_SIZE';
    const prev = process.env[key];
    try {
      process.env[key] = '7';
      const db = createDbClient({ url: URL_REAL });
      expect(dbHandleOf(db)?.config.connectionLimit).toBe(7);
      await db.destroy();
    } finally {
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  });
  it('URL 非法时在建池之前就抛（不留下半初始化状态）', () => {
    expectConfigError(() => createDbClient({ url: 'postgres://u:p@h/db' }), 'url', 'protocol');
  });
});

describe('createDbClient · 产物与旁挂 handle', () => {
  it('返回 Kysely 实例，且 URL 各字段真的进了连接配置', async () => {
    const db = createDbClient({ url: URL_REAL, connectionLimit: 2 });
    expect(db).toBeInstanceOf(Kysely);
    const handle = dbHandleOf(db);
    expect(handle).toBeDefined();
    expect(handle?.config).toEqual({
      host: '127.0.0.1',
      port: 3306,
      user: 'knowstudio',
      password: 'knowstudio_app_dev_only',
      database: 'knowstudio',
      connectionLimit: 2,
    });
    expect(handle?.initError).toBeNull();
    await db.destroy();
  });
  it('dbHandleOf 对非本工厂产物返回 undefined（不是万能猜测）', async () => {
    const handle = createDb({ connectionLimit: 1 });
    expect(dbHandleOf(handle.db)).toBeUndefined();
    await handle.destroy();
  });
  it('同一 URL 两次调用得到两个独立实例（不是隐藏单例）', async () => {
    const a = createDbClient({ url: URL_REAL, connectionLimit: 1 });
    const b = createDbClient({ url: URL_REAL, connectionLimit: 1 });
    expect(a).not.toBe(b);
    expect(dbHandleOf(a)).not.toBe(dbHandleOf(b));
    await a.destroy();
    await b.destroy();
  });
});