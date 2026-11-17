/**
 * 连接门禁单测：版本 fail-fast 与口径断言。
 *
 * 为什么这些必须是**单测**而不是只靠真实库：真实实例是 8.4.13，
 * 永远走不到「低版本拒绝」分支。只有喂合成 capabilities 才能证明
 * 门禁真的会拒绝，而不是写了个永不触发的装饰。
 * 断言一律用结构化 code / violations 字段，不按 error.message 猜类型。
 */
import { describe, expect, it } from 'vitest';
import {
  DbConfigMismatchError,
  DbVersionParseError,
  DbVersionUnsupportedError,
  MIN_MYSQL_VERSION,
  checkCapabilities,
  compareVersion,
  dbConfigFromEnv,
  parseMysqlVersion,
} from '../src/client.js';
import type { ServerCapabilities } from '../src/client.js';

/** 基线取本实例 8.4.13 的**实测值**，保证「接受」分支不是凭空构造的。 */
const REAL: ServerCapabilities = {
  version: '8.4.13',
  sqlMode: 'IGNORE_SPACE,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION',
  transactionIsolation: 'READ-COMMITTED',
  ngramTokenSize: 2,
  timeZone: '+00:00',
  characterSetServer: 'utf8mb4',
  collationServer: 'utf8mb4_0900_ai_ci',
  characterSetClient: 'utf8mb4',
  collationConnection: 'utf8mb4_0900_ai_ci',
  innodbLockWaitTimeout: 50,
};

const caps = (over: Partial<ServerCapabilities> = {}): ServerCapabilities => ({ ...REAL, ...over });

describe('parseMysqlVersion', () => {
  it('解析纯三段版本', () => {
    expect(parseMysqlVersion('8.4.13')).toEqual({ major: 8, minor: 4, patch: 13 });
  });
  it('忽略 -log 后缀', () => {
    expect(parseMysqlVersion('8.0.17-log')).toEqual({ major: 8, minor: 0, patch: 17 });
  });
  it('忽略发行版后缀', () => {
    expect(parseMysqlVersion('8.4.13-0ubuntu1')).toEqual({ major: 8, minor: 4, patch: 13 });
  });
  it('容忍首尾空白', () => {
    expect(parseMysqlVersion('  8.0.17  ')).toEqual({ major: 8, minor: 0, patch: 17 });
  });
  it('无法解析时抛结构化错误', () => {
    for (const bad of ['', 'unknown', '8.4', 'v8.4.13']) {
      let caught: unknown;
      try {
        parseMysqlVersion(bad);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(DbVersionParseError);
      expect((caught as DbVersionParseError).code).toBe('DB_VERSION_PARSE_FAILED');
      expect((caught as DbVersionParseError).raw).toBe(bad);
    }
  });
});

describe('compareVersion', () => {
  it('按 major/minor/patch 逐级比较', () => {
    const v = (s: string) => parseMysqlVersion(s);
    expect(compareVersion(v('8.0.16'), v('8.0.17'))).toBe(-1);
    expect(compareVersion(v('8.0.17'), v('8.0.17'))).toBe(0);
    expect(compareVersion(v('8.0.18'), v('8.0.17'))).toBe(1);
    expect(compareVersion(v('8.4.13'), v('8.0.17'))).toBe(1);
    expect(compareVersion(v('5.7.44'), v('8.0.17'))).toBe(-1);
    expect(compareVersion(v('9.0.0'), v('8.4.13'))).toBe(1);
  });
  it('不是字符串字典序比较（8.0.9 < 8.0.17）', () => {
    const v = (s: string) => parseMysqlVersion(s);
    expect(compareVersion(v('8.0.9'), v('8.0.17'))).toBe(-1);
  });
});

describe('checkCapabilities · 版本硬下限', () => {
  it('硬性下限就是 8.0.17', () => {
    expect(MIN_MYSQL_VERSION).toBe('8.0.17');
  });

  it('接受真实 8.4.13 口径', () => {
    expect(checkCapabilities(caps())).toEqual(REAL);
  });

  it('接受边界值 8.0.17（多值索引起始版本）', () => {
    expect(checkCapabilities(caps({ version: '8.0.17' })).version).toBe('8.0.17');
  });

  it('拒绝 8.0.16：CHECK 会被解析但忽略，超支兜底静默失效', () => {
    let caught: unknown;
    try {
      checkCapabilities(caps({ version: '8.0.16' }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DbVersionUnsupportedError);
    expect((caught as DbVersionUnsupportedError).code).toBe('DB_VERSION_UNSUPPORTED');
    expect((caught as DbVersionUnsupportedError).actual).toBe('8.0.16');
    expect((caught as DbVersionUnsupportedError).required).toBe('8.0.17');
  });

  it('拒绝 5.7.44', () => {
    expect(() => checkCapabilities(caps({ version: '5.7.44' }))).toThrowError(DbVersionUnsupportedError);
  });

  it('拒绝 MariaDB：数字上能过 8.0.17，但无 ngram parser 与多值索引', () => {
    let caught: unknown;
    try {
      checkCapabilities(caps({ version: '11.4.2-MariaDB' }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DbVersionUnsupportedError);
    expect((caught as DbVersionUnsupportedError).code).toBe('DB_VERSION_UNSUPPORTED');
    expect((caught as DbVersionUnsupportedError).reason).toContain('MariaDB');
  });

  it('版本不足时先于口径报错（不被 violations 掩盖）', () => {
    let caught: unknown;
    try {
      checkCapabilities(caps({ version: '5.7.44', ngramTokenSize: 1, timeZone: '+08:00' }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DbVersionUnsupportedError);
  });
});

describe('checkCapabilities · 口径断言', () => {
  const expectViolation = (over: Partial<ServerCapabilities>, key: string): void => {
    let caught: unknown;
    try {
      checkCapabilities(caps(over));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DbConfigMismatchError);
    const err = caught as DbConfigMismatchError;
    expect(err.code).toBe('DB_CONFIG_MISMATCH');
    expect(err.violations.map((v) => v.key)).toContain(key);
  };

  it('ngram_token_size≠2 拒绝（中文双字切分）', () => {
    expectViolation({ ngramTokenSize: 1 }, 'ngram_token_size');
    expectViolation({ ngramTokenSize: 3 }, 'ngram_token_size');
  });

  it('缺 STRICT_TRANS_TABLES 拒绝（防静默截断）', () => {
    expectViolation({ sqlMode: 'NO_ZERO_DATE,NO_ENGINE_SUBSTITUTION' }, 'sql_mode');
  });

  it('会话时区非 +00:00 拒绝（DATETIME 存 UTC）', () => {
    expectViolation({ timeZone: '+08:00' }, 'time_zone');
    expectViolation({ timeZone: 'SYSTEM' }, 'time_zone');
  });

  it('连接 collation 非 utf8mb4_0900_ai_ci 拒绝（FK 两端一致，否则 3780）', () => {
    expectViolation({ collationConnection: 'utf8mb4_general_ci' }, 'collation_connection');
  });

  it('连接字符集非 utf8mb4 拒绝', () => {
    expectViolation({ characterSetClient: 'utf8mb3' }, 'character_set_client');
  });

  it('服务端字符集/排序规则不符拒绝', () => {
    expectViolation({ characterSetServer: 'latin1' }, 'character_set_server');
    expectViolation({ collationServer: 'utf8mb4_general_ci' }, 'collation_server');
  });

  it('隔离级别不在允许集合内拒绝', () => {
    expectViolation({ transactionIsolation: 'SERIALIZABLE' }, 'transaction_isolation');
    expectViolation({ transactionIsolation: 'READ-UNCOMMITTED' }, 'transaction_isolation');
  });

  it('接受 REPEATABLE-READ（架构默认 RR，配额/队列事务显式降 RC）', () => {
    expect(checkCapabilities(caps({ transactionIsolation: 'REPEATABLE-READ' })).transactionIsolation).toBe('REPEATABLE-READ');
  });

  it('一次报全所有违规，便于运维一轮修完', () => {
    let caught: unknown;
    try {
      checkCapabilities(caps({ ngramTokenSize: 1, timeZone: '+08:00', characterSetClient: 'latin1' }));
    } catch (err) {
      caught = err;
    }
    const keys = (caught as DbConfigMismatchError).violations.map((v) => v.key);
    expect(keys).toEqual(expect.arrayContaining(['ngram_token_size', 'time_zone', 'character_set_client']));
    expect(keys).toHaveLength(3);
  });

  it('每条违规都带 actual/expected/why，不是空壳报错', () => {
    let caught: unknown;
    try {
      checkCapabilities(caps({ ngramTokenSize: 1 }));
    } catch (err) {
      caught = err;
    }
    const v = (caught as DbConfigMismatchError).violations[0];
    expect(v?.actual).toBe(1);
    expect(v?.expected).toBe('2');
    expect(typeof v?.why).toBe('string');
    expect((v?.why ?? '').length).toBeGreaterThan(0);
  });
});

describe('dbConfigFromEnv', () => {
  it('无环境变量时用与 infra 一致的 dev 默认值', () => {
    const c = dbConfigFromEnv({});
    expect(c.host).toBe('127.0.0.1');
    expect(c.port).toBe(3306);
    expect(c.database).toBe('knowstudio');
    expect(c.user).toBe('knowstudio');
  });

  it('环境变量覆盖默认值', () => {
    const c = dbConfigFromEnv({
      KNOWSTUDIO_DB_HOST: 'db.internal',
      KNOWSTUDIO_DB_PORT: '3307',
      KNOWSTUDIO_DB_NAME: 'ks_prod',
      KNOWSTUDIO_DB_POOL_SIZE: '20',
    });
    expect(c).toMatchObject({ host: 'db.internal', port: 3307, database: 'ks_prod', connectionLimit: 20 });
  });

  it('非法端口/池大小回退到安全默认，不产生 NaN 连接', () => {
    const c = dbConfigFromEnv({ KNOWSTUDIO_DB_PORT: 'abc', KNOWSTUDIO_DB_POOL_SIZE: '' });
    expect(c.port).toBe(3306);
    expect(c.connectionLimit).toBe(10);
  });
});