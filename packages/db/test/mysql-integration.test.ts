/**
 * T-03 对**真实 MySQL 8.4** 的集成证明（DoD ①②③④）。
 *
 * 为什么全部 DB 用例集中在一个文件：vitest 默认**并行跑文件**、文件内顺序跑用例。
 * 3780 探针要建临时表，若分散到多文件并行，37 表计数断言会被别的文件的探针污染。
 * 集中在此 + 每个探针 finally 清理 ⇒ 静止态恒为 37 张表。
 *
 * 连接走 mysql2 over TCP（127.0.0.1:3306），不使用 docker CLI。
 * 错误判定一律用结构化 **errno**，不按 error.message 猜类型。
 *
 * 负向验证不是「写了约束」而是「约束真的拦住了」：
 *   - FK 两端 collation 不一致 → errno 3780（并附**匹配则成功**的正向对照）
 *   - used + reserved > total   → errno 3819（并附 =total 的边界正向对照，事务回滚不留痕）
 *   - ngram 中文双字 FULLTEXT 真命中；单字 FULLTEXT 返回 0 而 LIKE 命中（§4.3.5 静默失效的实证）
 *   - 同用户第二条活跃渲染 → errno 1062（STORED 生成列 + 唯一索引的条件唯一真的生效）
 *   - 同平台第二个 current 版本 → errno 1062
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import { assertServerCapabilities, createDb } from '../src/client.js';
import type { DbHandle } from '../src/client.js';
// 冻结入口走**公共出口**（WP12 在 apps/api 里 import 的就是这条路径），不是内部模块
import { createDbClient, dbHandleOf } from '../src/index.js';
import type { Database } from '../src/schema/index.js';
import {
  applySeed,
  loadSeedData,
  measureSeedCounts,
  seedId,
  SEED_EXPECTATIONS,
} from '../migrations/seed.js';
import { DEFAULT_LEDGER_PATH, listTables, migrate, readLedger } from '../migrations/runner.js';
import { createdTableName, splitSqlStatements } from '../migrations/sql-split.js';
import {
  compareAll,
  parseShowCreateDump,
  stripAutoIncrementCounter,
} from '../migrations/ddl-compare.js';
import { FORBIDDEN_TABLES, TABLE_ORDER, TOTAL_TABLE_COUNT } from '../migrations/tables.js';

const baselineText = readFileSync(
  fileURLToPath(new URL('../migrations/0001_baseline.sql', import.meta.url)),
  'utf8',
);
const migrationText = readFileSync(
  fileURLToPath(new URL('../migrations/0002_user_source_config.sql', import.meta.url)),
  'utf8',
);
const fixtureText = readFileSync(
  fileURLToPath(new URL('../../../fixtures/live-show-create-table.sql', import.meta.url)),
  'utf8',
);

const expectedDdls = new Map<string, string>();
for (const stmt of [...splitSqlStatements(baselineText), ...splitSqlStatements(migrationText)]) {
  const t = createdTableName(stmt);
  if (t !== null) expectedDdls.set(t, stmt);
}

const seedData = loadSeedData();
const USER_ID = seedId('u', seedData.user.key);

let handle: DbHandle;
let db: Kysely<Database>;

/** 探针用哨兵错误：只为强制事务回滚，不是失败。 */
class ProbeRollback extends Error {
  readonly code = 'PROBE_ROLLBACK';
}

interface SqlErrorLike {
  errno?: number;
  code?: string;
  sqlState?: string;
}

/** 断言某条 SQL **必须**失败且 errno 精确匹配。没失败就是约束没生效。 */
async function expectSqlErrno(run: () => Promise<unknown>, errno: number): Promise<SqlErrorLike> {
  let caught: unknown;
  try {
    await run();
  } catch (err) {
    caught = err;
  }
  expect(caught, `期望 errno ${String(errno)}，但语句竟然成功了（约束未生效）`).toBeDefined();
  const e = caught as SqlErrorLike;
  expect(e.errno, `errno 不符，实际 code=${String(e.code)}`).toBe(errno);
  return e;
}

async function showCreate(table: string): Promise<string> {
  const { rows } = await sql
    .raw<Record<string, unknown>>(`SHOW CREATE TABLE \`${table}\``)
    .execute(db);
  const values = Object.values(rows[0] as Record<string, unknown>);
  return values[1] as string;
}

async function dropProbe(table: string): Promise<void> {
  await sql.raw(`DROP TABLE IF EXISTS \`${table}\``).execute(db);
}

beforeAll(async () => {
  handle = createDb();
  db = handle.db;
  // 门禁：低于 8.0.17 直接拒绝，不静默降级
  await assertServerCapabilities(db);
  await migrate({ handle });
  await applySeed({ handle });
}, 180_000);

afterAll(async () => {
  // 静止态复核：探针必须全部清理干净
  if (db !== undefined) {
    const tables = await listTables(db, handle.config.database);
    expect(tables).toHaveLength(TOTAL_TABLE_COUNT);
  }
  await handle?.destroy();
}, 60_000);

describe('DoD① 迁移真的跑进了 MySQL', () => {
  it('服务端版本与口径满足硬性要求', async () => {
    const caps = await assertServerCapabilities(db);
    expect(caps.version).toBe('8.4.13');
    expect(caps.ngramTokenSize).toBe(2);
    expect(caps.timeZone).toBe('+00:00');
    expect(caps.collationConnection).toBe('utf8mb4_0900_ai_ci');
    expect(caps.sqlMode).toContain('STRICT_TRANS_TABLES');
  });

  it('库里恰好 37 张基表，集合与 TABLE_ORDER 双向一致', async () => {
    const tables = await listTables(db, handle.config.database);
    expect(tables).toHaveLength(TOTAL_TABLE_COUNT);
    expect([...tables].sort()).toEqual([...TABLE_ORDER].sort());
  });

  it('没有任何禁止表（会话存 Redis；内置 Migrator 已禁用）', async () => {
    const tables = new Set(await listTables(db, handle.config.database));
    for (const t of FORBIDDEN_TABLES) expect(tables.has(t), t).toBe(false);
  });

  it('重复执行迁移是幂等的：第二次整体跳过，表数不变', async () => {
    const again = await migrate({ handle });
    expect(again.applied).toEqual([]);
    expect(again.skipped).toContain('0001_baseline');
    expect(again.tableCount).toBe(TOTAL_TABLE_COUNT);
  });

  it('文件账本记录了基线，且 sha256 与磁盘原文一致', () => {
    const ledger = readLedger(DEFAULT_LEDGER_PATH);
    expect(ledger.version).toBe(1);
    const entry = ledger.migrations.find((m) => m.id === '0001_baseline');
    expect(entry).toBeDefined();
    const sha = createHash('sha256').update(baselineText, 'utf8').digest('hex');
    expect(entry?.sha256).toBe(sha);
    expect(entry?.statementCount).toBe(36);
    expect(sha).toBe('2da4a7b4d531bb43247fe42c3e90e3fadd97084b1e25b52a7280c6c31eafab8f');
  });

  it('37 张表全部是 InnoDB 且表默认排序规则为 utf8mb4_0900_ai_ci', async () => {
    const { rows } = await sql<{ TABLE_NAME: string; ENGINE: string; TABLE_COLLATION: string }>`
      SELECT TABLE_NAME, ENGINE, TABLE_COLLATION
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ${handle.config.database} AND TABLE_TYPE = 'BASE TABLE'
    `.execute(db);
    expect(rows).toHaveLength(TOTAL_TABLE_COUNT);
    for (const r of rows) {
      expect(r.ENGINE, r.TABLE_NAME).toBe('InnoDB');
      expect(r.TABLE_COLLATION, r.TABLE_NAME).toBe('utf8mb4_0900_ai_ci');
    }
  });
});

describe('DoD② 逐表 SHOW CREATE TABLE 与架构 §4.4 比对', () => {
  it('37/37 逐表一致（列/类型/可空/默认/索引/约束/FK/表选项）', async () => {
    const actual = new Map<string, string>();
    for (const t of TABLE_ORDER) actual.set(t, await showCreate(t));
    const report = compareAll(expectedDdls, actual);
    expect(report.diffs.map((d) => `${d.table}: ${d.problems.join(' | ')}`)).toEqual([]);
    expect(report.identical).toBe(TOTAL_TABLE_COUNT);
    expect(report.total).toBe(TOTAL_TABLE_COUNT);
  }, 60_000);

  it('取证文件未过期：与当前活库输出逐字相同（仅抹掉数据态的 AUTO_INCREMENT 计数器）', async () => {
    const fixture = parseShowCreateDump(fixtureText);
    expect(fixture.size).toBe(TOTAL_TABLE_COUNT);
    let countersStripped = 0;
    for (const t of TABLE_ORDER) {
      const live = await showCreate(t);
      const want = fixture.get(t) as string;
      if (stripAutoIncrementCounter(live) !== live) countersStripped += 1;
      expect(stripAutoIncrementCounter(live), `取证文件与活库不一致：${t}`).toBe(want);
      // 取证文件本身必须是「无计数器」的纯 schema 快照，否则上面这行会被两侧同时抹平而失去意义
      expect(stripAutoIncrementCounter(want), `取证文件不应含计数器：${t}`).toBe(want);
    }
    // 播种确实往自增表插过行：至少 1 张表的活库输出带计数器（证明抹除动作不是空转）
    expect(countersStripped).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it('抹除计数器不会掩盖真实 schema 差异（负向对照）', async () => {
    const fixture = parseShowCreateDump(fixtureText);
    const live = await showCreate('quota_ledger');
    expect(stripAutoIncrementCounter(live)).toBe(fixture.get('quota_ledger'));
    // 只改一个字符宽度：抹除计数器后仍必须不相等
    const mutated = (fixture.get('quota_ledger') as string).replace('varchar(64)', 'varchar(63)');
    expect(mutated).not.toBe(fixture.get('quota_ledger'));
    expect(stripAutoIncrementCounter(live)).not.toBe(mutated);
    // 列上的 AUTO_INCREMENT 属性属于 schema，不得被抹掉
    const withColAttr =
      'CREATE TABLE `t` (\n  `n` bigint NOT NULL AUTO_INCREMENT,\n  PRIMARY KEY (`n`)\n) ENGINE=InnoDB AUTO_INCREMENT=7 DEFAULT CHARSET=utf8mb4';
    expect(stripAutoIncrementCounter(withColAttr)).toBe(
      'CREATE TABLE `t` (\n  `n` bigint NOT NULL AUTO_INCREMENT,\n  PRIMARY KEY (`n`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4',
    );
  }, 60_000);

  it('app_user 的 DDL 未被改动（客户硬约束）', async () => {
    const ddl = await showCreate('app_user');
    expect(ddl).toContain('`password_hash` varchar(255) DEFAULT NULL');
    expect(ddl).toContain('UNIQUE KEY `uq_user_phone` (`phone`)');
    expect(ddl).toContain('UNIQUE KEY `uq_user_email` (`email`)');
    expect(ddl).toContain('CONSTRAINT `ck_user_contact` CHECK');
    // 与架构基线结构一致（不是只看几个子串）
    expect(
      compareAll(
        new Map([['app_user', expectedDdls.get('app_user') as string]]),
        new Map([['app_user', ddl]]),
      ).identical,
    ).toBe(1);
  });
});

describe('DoD③ 种子真的落库，计数由 SELECT 实测', () => {
  it('全部关键计数命中 SPEC §4.3', async () => {
    const c = await measureSeedCounts(db, USER_ID);
    expect(c.works).toBe(SEED_EXPECTATIONS.works);
    expect(c.materials).toBe(SEED_EXPECTATIONS.materials);
    expect(c.libraryMaterials).toBe(SEED_EXPECTATIONS.libraryMaterials);
    expect(c.workMaterials).toBe(SEED_EXPECTATIONS.collected);
    expect(c.topics).toBe(SEED_EXPECTATIONS.topics);
    expect(c.scriptSections).toBe(SEED_EXPECTATIONS.scriptSections);
    expect(c.scriptLines).toBe(SEED_EXPECTATIONS.scriptLines);
    expect(c.scriptChars).toBe(SEED_EXPECTATIONS.scriptChars);
    expect(c.quotaTotal).toBe(SEED_EXPECTATIONS.quotaTotal);
    expect(c.quotaUsed).toBe(SEED_EXPECTATIONS.quotaUsed);
    expect(c.quotaReserved).toBe(SEED_EXPECTATIONS.quotaReserved);
    expect(c.quotaLeft).toBe(SEED_EXPECTATIONS.quotaLeft);
    expect(c.ledgerCommitPoints).toBe(SEED_EXPECTATIONS.quotaUsed);
    expect(c.platformRules).toBe(SEED_EXPECTATIONS.platformRules);
    expect(c.voices).toBe(SEED_EXPECTATIONS.voices);
    expect(c.templates).toBe(SEED_EXPECTATIONS.templates);
    expect(c.trends).toBe(SEED_EXPECTATIONS.trends);
  }, 60_000);

  it('212 字来自 MySQL 的 CHAR_LENGTH，不是应用侧自说自话', async () => {
    const { rows } = await sql<{ n: number; mismatches: number }>`
      SELECT COALESCE(SUM(char_count), 0) AS n,
             SUM(CASE WHEN char_count <> CHAR_LENGTH(text) THEN 1 ELSE 0 END) AS mismatches
      FROM script_line
    `.execute(db);
    expect(Number(rows[0]?.n)).toBe(212);
    expect(Number(rows[0]?.mismatches)).toBe(0);
  });

  it('配额恒等式 left = total - used - reserved 在库里成立', async () => {
    const { rows } = await sql<{ total: number; used: number; reserved: number; ok: number }>`
      SELECT total, used, reserved,
             CASE WHEN total - used - reserved = 38 THEN 1 ELSE 0 END AS ok
      FROM quota_account WHERE user_id = ${USER_ID}
    `.execute(db);
    expect(Number(rows[0]?.total)).toBe(60);
    expect(Number(rows[0]?.used)).toBe(22);
    expect(Number(rows[0]?.reserved)).toBe(0);
    expect(Number(rows[0]?.ok)).toBe(1);
  });

  it('重复执行种子是幂等的：applied=false 且计数不变', async () => {
    const again = await applySeed({ handle });
    expect(again.applied).toBe(false);
    expect(again.counts.works).toBe(3);
    expect(again.counts.materials).toBe(10);
    expect(again.counts.scriptChars).toBe(212);
  }, 60_000);

  it('音色凭证是占位而非伪造授权（R4 待 T-36）', async () => {
    // mysql2 会把 JSON 列直接反序列化成对象，故用 CAST(... AS CHAR) 取库里存的原文再解析，
    // 断言对象是「库里真实文本」而不是驱动二次加工的产物。
    const { rows } = await sql<{ id: string; ev: string }>`
      SELECT id, CAST(license_evidence AS CHAR) AS ev FROM voice_catalog ORDER BY id
    `.execute(db);
    expect(rows).toHaveLength(4);
    for (const r of rows) {
      expect(typeof r.ev).toBe('string');
      const ev = JSON.parse(r.ev) as { type?: string; status?: string };
      expect(ev.type).toBe('placeholder');
      expect(ev.status).toBe('pending');
    }
    const { rows: samples } = await sql<{ k: string }>`
      SELECT sample_layer_key AS k FROM voice_catalog
    `.execute(db);
    for (const s of samples) expect(s.k.startsWith('fixture://voice/')).toBe(true);
  });

  it('keyword_hash 生成列真的等于 MD5(keyword)', async () => {
    const { rows } = await sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM search_session WHERE keyword_hash <> MD5(keyword)
    `.execute(db);
    expect(Number(rows[0]?.n)).toBe(0);
  });

  it('素材多值索引可被优化器真正选中（不是建了个摆设）', async () => {
    const { rows } = await sql<{ tag: string }>`
      SELECT JSON_UNQUOTE(JSON_EXTRACT(tags, '$[0]')) AS tag FROM material WHERE JSON_LENGTH(tags) > 0 LIMIT 1
    `.execute(db);
    const tag = rows[0]?.tag;
    expect(typeof tag).toBe('string');
    const { rows: plan } = await sql
      .raw<Record<string, unknown>>(
        `EXPLAIN SELECT id FROM material WHERE '${(tag as string).replace(/'/g, "''")}' MEMBER OF (tags)`,
      )
      .execute(db);
    const text = JSON.stringify(plan);
    expect(text).toContain('ix_material_tags');
  });
});

describe('DoD④ 负向验证 · FK collation 不一致必须 errno 3780', () => {
  const BAD = 't03_probe_fk_bad';
  const GOOD = 't03_probe_fk_good';

  it('引用列 collation 与被引用列不一致 → 3780；一致 → 建表成功（正向对照）', async () => {
    try {
      await expectSqlErrno(
        () =>
          sql
            .raw(
              `
          CREATE TABLE \`${BAD}\` (
            id CHAR(36) COLLATE ascii_bin NOT NULL,
            user_id CHAR(36) COLLATE utf8mb4_general_ci NOT NULL,
            PRIMARY KEY (id),
            CONSTRAINT fk_probe_bad FOREIGN KEY (user_id) REFERENCES app_user (id)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
        `,
            )
            .execute(db),
        3780,
      );

      // 正向对照：唯一改动是 collation 对齐，必须成功。
      // 没有这一半，就无法排除「建表失败其实是别的原因」。
      await sql
        .raw(
          `
        CREATE TABLE \`${GOOD}\` (
          id CHAR(36) COLLATE ascii_bin NOT NULL,
          user_id CHAR(36) COLLATE ascii_bin NOT NULL,
          PRIMARY KEY (id),
          CONSTRAINT fk_probe_good FOREIGN KEY (user_id) REFERENCES app_user (id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
      `,
        )
        .execute(db);
      const tables = await listTables(db, handle.config.database);
      expect(tables).toContain(GOOD);
      expect(tables).not.toContain(BAD);
    } finally {
      await dropProbe(GOOD);
      await dropProbe(BAD);
    }
  }, 60_000);

  it('探针清理后仍是 36 张表', async () => {
    expect(await listTables(db, handle.config.database)).toHaveLength(TOTAL_TABLE_COUNT);
  });
});

describe('DoD④ 负向验证 · 配额 CHECK 真的拦住超支', () => {
  it('used 超 total → errno 3819，且原值未被改动', async () => {
    await expectSqlErrno(
      () => sql`UPDATE quota_account SET used = 61 WHERE user_id = ${USER_ID}`.execute(db),
      3819,
    );
    const { rows } = await sql<{
      used: number;
    }>`SELECT used FROM quota_account WHERE user_id = ${USER_ID}`.execute(db);
    expect(Number(rows[0]?.used)).toBe(22);
  });

  it('used + reserved 超 total → errno 3819（不是只查 used）', async () => {
    await expectSqlErrno(
      () => sql`UPDATE quota_account SET reserved = 39 WHERE user_id = ${USER_ID}`.execute(db),
      3819,
    );
  });

  it('负数 used / reserved / total 各自被对应 CHECK 拦住', async () => {
    await expectSqlErrno(
      () => sql`UPDATE quota_account SET used = -1 WHERE user_id = ${USER_ID}`.execute(db),
      3819,
    );
    await expectSqlErrno(
      () => sql`UPDATE quota_account SET reserved = -1 WHERE user_id = ${USER_ID}`.execute(db),
      3819,
    );
    await expectSqlErrno(
      () => sql`UPDATE quota_account SET total = -1 WHERE user_id = ${USER_ID}`.execute(db),
      3819,
    );
  });

  it('边界 used+reserved = total 必须允许（事务回滚，不留痕）', async () => {
    let rolledBack = false;
    try {
      await db.transaction().execute(async (trx) => {
        await sql`UPDATE quota_account SET reserved = 38 WHERE user_id = ${USER_ID}`.execute(trx);
        const { rows } = await sql<{ ok: number }>`
          SELECT CASE WHEN used + reserved = total THEN 1 ELSE 0 END AS ok
          FROM quota_account WHERE user_id = ${USER_ID}
        `.execute(trx);
        expect(Number(rows[0]?.ok)).toBe(1);
        throw new ProbeRollback();
      });
    } catch (err) {
      expect((err as ProbeRollback).code).toBe('PROBE_ROLLBACK');
      rolledBack = true;
    }
    expect(rolledBack).toBe(true);
    const { rows } = await sql<{
      reserved: number;
    }>`SELECT reserved FROM quota_account WHERE user_id = ${USER_ID}`.execute(db);
    expect(Number(rows[0]?.reserved)).toBe(0);
  });

  it('quota_reservation.points <= 0 被 ck_rsv_points 拦住', async () => {
    const workId = await firstWorkId();
    const id = 't03_probe_rsv_0000000000000001';
    try {
      await expectSqlErrno(
        () =>
          sql`
          INSERT INTO quota_reservation (id, user_id, work_id, points, state, expires_at)
          VALUES (${id}, ${USER_ID}, ${workId}, 0, 'held', '2026-12-13 00:00:00.000')
        `.execute(db),
        3819,
      );
    } finally {
      await sql`DELETE FROM quota_reservation WHERE id = ${id}`.execute(db);
    }
  });
});

async function firstWorkId(): Promise<string> {
  const { rows } = await sql<{
    id: string;
  }>`SELECT id FROM work WHERE user_id = ${USER_ID} ORDER BY created_at LIMIT 1`.execute(db);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('种子里没有作品，无法做 FK 探针');
  return id;
}

describe('DoD④ 负向验证 · ngram 中文 FULLTEXT 真命中', () => {
  it('双字词「费曼」经 MATCH…AGAINST 命中 w1', async () => {
    const { rows } = await sql<{ title: string }>`
      SELECT title FROM work WHERE MATCH(title) AGAINST ('费曼' IN NATURAL LANGUAGE MODE)
    `.execute(db);
    expect(rows.map((r) => r.title)).toContain('费曼学习法：为什么你学了就忘');
  });

  it('双字词「刻意」命中 w3，证明不是只有第一条数据能搜到', async () => {
    const { rows } = await sql<{ title: string }>`
      SELECT title FROM work WHERE MATCH(title) AGAINST ('刻意' IN NATURAL LANGUAGE MODE)
    `.execute(db);
    expect(rows.map((r) => r.title)).toContain('刻意练习：天才是怎么练出来的');
  });

  it('单字「费」FULLTEXT 返回 0 —— ngram_token_size=2 的静默失效实证', async () => {
    const { rows } = await sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM work WHERE MATCH(title) AGAINST ('费' IN NATURAL LANGUAGE MODE)
    `.execute(db);
    expect(Number(rows[0]?.n)).toBe(0);
  });

  it('同一个单字用 LIKE 能命中 —— 故单字查询必须降级 LIKE（§4.3.5）', async () => {
    const { rows } = await sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM work WHERE title LIKE '%费%'
    `.execute(db);
    expect(Number(rows[0]?.n)).toBeGreaterThan(0);
  });

  it('material 的 (title, body_text) 复合 FULLTEXT 也能中文命中', async () => {
    const { rows } = await sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM material WHERE MATCH(title, body_text) AGAINST ('费曼' IN NATURAL LANGUAGE MODE)
    `.execute(db);
    expect(Number(rows[0]?.n)).toBeGreaterThan(0);
  });

  it('EXPLAIN 证明 FULLTEXT 索引被真正使用', async () => {
    const { rows } = await sql
      .raw<Record<string, unknown>>(
        "EXPLAIN SELECT id FROM work WHERE MATCH(title) AGAINST ('费曼' IN NATURAL LANGUAGE MODE)",
      )
      .execute(db);
    expect(JSON.stringify(rows)).toContain('ft_work_title');
  });
});

describe('DoD④ 负向验证 · 每用户渲染并发上限 1 真的生效', () => {
  const A = 't03_probe_job_a_0000000000001';
  const B = 't03_probe_job_b_0000000000001';
  const C = 't03_probe_job_c_0000000000001';
  const D = 't03_probe_job_d_0000000000001';

  it('第二条活跃渲染 → 1062；已完成/非渲染类型不受限（NULL 互不相等）', async () => {
    const workId = await firstWorkId();
    const ins = (id: string, type: string, status: string) =>
      sql`
      INSERT INTO render_job (id, work_id, user_id, type, status)
      VALUES (${id}, ${workId}, ${USER_ID}, ${type}, ${status})
    `.execute(db);
    try {
      await ins(A, 'hd', 'queued');
      // 同用户同类型第二条活跃 → 必须被条件唯一索引拦住
      const e = await expectSqlErrno(() => ins(B, 'hd', 'queued'), 1062);
      expect(String(e.code)).toBe('ER_DUP_ENTRY');

      // 已 succeeded → 生成列为 NULL → 不受限
      await ins(C, 'hd', 'succeeded');
      // 非渲染类型（search）即使 queued → 生成列为 NULL → 不受限
      await ins(D, 'search', 'queued');

      const { rows } = await sql<{ id: string; flag: number | null }>`
        SELECT id, active_render_flag AS flag FROM render_job WHERE id IN (${A}, ${C}, ${D}) ORDER BY id
      `.execute(db);
      const byId = new Map(rows.map((r) => [r.id, r.flag]));
      expect(byId.get(A)).toBe(1);
      expect(byId.get(C)).toBeNull();
      expect(byId.get(D)).toBeNull();
    } finally {
      for (const id of [A, B, C, D]) await sql`DELETE FROM render_job WHERE id = ${id}`.execute(db);
    }
  }, 60_000);

  it('把活跃任务改为 succeeded 后，同用户可再开一条（释放并发位）', async () => {
    const workId = await firstWorkId();
    try {
      await sql`INSERT INTO render_job (id, work_id, user_id, type, status) VALUES (${A}, ${workId}, ${USER_ID}, 'hd', 'running')`.execute(
        db,
      );
      await sql`UPDATE render_job SET status = 'succeeded' WHERE id = ${A}`.execute(db);
      await sql`INSERT INTO render_job (id, work_id, user_id, type, status) VALUES (${B}, ${workId}, ${USER_ID}, 'hd', 'queued')`.execute(
        db,
      );
      const { rows } = await sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM render_job WHERE user_id = ${USER_ID} AND active_render_flag = 1
      `.execute(db);
      expect(Number(rows[0]?.n)).toBe(1);
    } finally {
      for (const id of [A, B]) await sql`DELETE FROM render_job WHERE id = ${id}`.execute(db);
    }
  }, 60_000);

  it('探针清理后 render_job 回到种子态（0 条）', async () => {
    const { rows } = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM render_job`.execute(db);
    expect(Number(rows[0]?.n)).toBe(0);
  });
});

describe('DoD④ 负向验证 · 每平台恰好一个 current 版本', () => {
  it('同平台第二个 is_current=1 → 1062；is_current=0 可共存', async () => {
    const { rows } = await sql<{ platform_id: string; version: number }>`
      SELECT platform_id, version FROM platform_rule WHERE is_current = 1 ORDER BY platform_id LIMIT 1
    `.execute(db);
    const platformId = rows[0]?.platform_id;
    expect(typeof platformId).toBe('string');
    const baseVersion = Number(rows[0]?.version);
    const vBad = baseVersion + 100;
    const vOk = baseVersion + 101;
    const ins = (version: number, isCurrent: number) =>
      sql`
      INSERT INTO platform_rule
        (platform_id, version, name, ratio, max_duration, orient, brand_color, style_hint,
         title_max, title_hard_max, tag_max, is_current)
      VALUES (${platformId as string}, ${version}, 'probe', '9:16', 60, 'vertical', '#000000', 'probe',
              20, 40, 5, ${isCurrent})
    `.execute(db);
    try {
      await expectSqlErrno(() => ins(vBad, 1), 1062);
      await ins(vOk, 0);
      const { rows: after } = await sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM platform_rule WHERE platform_id = ${platformId as string} AND is_current = 1
      `.execute(db);
      expect(Number(after[0]?.n)).toBe(1);
    } finally {
      await sql`DELETE FROM platform_rule WHERE platform_id = ${platformId as string} AND version IN (${vBad}, ${vOk})`.execute(
        db,
      );
    }
  }, 60_000);

  it('探针清理后 platform_rule 回到 4 条', async () => {
    const { rows } = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM platform_rule`.execute(db);
    expect(Number(rows[0]?.n)).toBe(4);
  });
});

describe('DoD④ 负向验证 · 其余关键约束真的生效', () => {
  it('ck_topic_basis：basis 为空数组的选题被拒（JSON_LENGTH >= 1）', async () => {
    const { rows } = await sql<{
      batch_id: string;
      work_id: string;
    }>`SELECT batch_id, work_id FROM topic LIMIT 1`.execute(db);
    const batchId = rows[0]?.batch_id as string;
    const workId = rows[0]?.work_id as string;
    const id = 't03_probe_topic_00000000000001';
    try {
      await expectSqlErrno(
        () =>
          sql`
          INSERT INTO topic (id, batch_id, work_id, hook, angle, blank_point, basis_material_ids, hook_fingerprint, ord)
          VALUES (${id}, ${batchId}, ${workId}, 'probe', 'probe', 'probe', '[]', ${'0'.repeat(64)}, 999)
        `.execute(db),
        3819,
      );
    } finally {
      await sql`DELETE FROM topic WHERE id = ${id}`.execute(db);
    }
  }, 60_000);

  it('ck_topic_emb_dim：维度不是 1024 的 embedding 被拒', async () => {
    const { rows } = await sql<{
      batch_id: string;
      work_id: string;
    }>`SELECT batch_id, work_id FROM topic LIMIT 1`.execute(db);
    const batchId = rows[0]?.batch_id as string;
    const workId = rows[0]?.work_id as string;
    const id = 't03_probe_topic_emb_000000001';
    try {
      await expectSqlErrno(
        () =>
          sql`
          INSERT INTO topic (id, batch_id, work_id, hook, angle, blank_point, basis_material_ids, embedding, hook_fingerprint, ord)
          VALUES (${id}, ${batchId}, ${workId}, 'probe', 'probe', 'probe', '["k1"]', '[1,2,3]', ${'1'.repeat(64)}, 998)
        `.execute(db),
        3819,
      );
    } finally {
      await sql`DELETE FROM topic WHERE id = ${id}`.execute(db);
    }
  }, 60_000);

  it('ck_work_phase：phase 越界（5）被拒', async () => {
    const workId = await firstWorkId();
    await expectSqlErrno(
      () => sql`UPDATE work SET phase = 5 WHERE id = ${workId}`.execute(db),
      3819,
    );
    const { rows } = await sql<{
      phase: number;
    }>`SELECT phase FROM work WHERE id = ${workId}`.execute(db);
    expect(Number(rows[0]?.phase)).toBeLessThanOrEqual(4);
  });

  it('ck_job_progress：progress 越界（101）被拒', async () => {
    const workId = await firstWorkId();
    const id = 't03_probe_job_prog_0000000001';
    try {
      await expectSqlErrno(
        () =>
          sql`
          INSERT INTO render_job (id, work_id, user_id, type, status, progress)
          VALUES (${id}, ${workId}, ${USER_ID}, 'hd', 'succeeded', 101)
        `.execute(db),
        3819,
      );
    } finally {
      await sql`DELETE FROM render_job WHERE id = ${id}`.execute(db);
    }
  }, 60_000);

  it('ck_user_contact：phone 与 email 同时为 NULL 被拒', async () => {
    const id = 't03_probe_user_00000000000001';
    try {
      await expectSqlErrno(
        () =>
          sql`INSERT INTO app_user (id, name, phone, email, plan_id) VALUES (${id}, 'probe', NULL, NULL, 'creator_168')`.execute(
            db,
          ),
        3819,
      );
    } finally {
      await sql`DELETE FROM app_user WHERE id = ${id}`.execute(db);
    }
  }, 60_000);

  it('FK 真的拦悬空引用：render_job.work_id 指向不存在的作品 → 1452', async () => {
    const id = 't03_probe_job_fk_000000000001';
    try {
      await expectSqlErrno(
        () =>
          sql`
          INSERT INTO render_job (id, work_id, user_id, type, status)
          VALUES (${id}, 't03_ghost_work_0000000000000', ${USER_ID}, 'hd', 'succeeded')
        `.execute(db),
        1452,
      );
    } finally {
      await sql`DELETE FROM render_job WHERE id = ${id}`.execute(db);
    }
  }, 60_000);

  it('uq_event_seq：同 job 同 seq 重复 → 1062（SSE 回放依据）', async () => {
    const workId = await firstWorkId();
    const jobId = 't03_probe_job_seq_0000000001';
    try {
      await sql`INSERT INTO render_job (id, work_id, user_id, type, status) VALUES (${jobId}, ${workId}, ${USER_ID}, 'hd', 'succeeded')`.execute(
        db,
      );
      await sql`INSERT INTO render_job_event (job_id, seq, event_type, payload) VALUES (${jobId}, 1, 'progress', '{}')`.execute(
        db,
      );
      await expectSqlErrno(
        () =>
          sql`INSERT INTO render_job_event (job_id, seq, event_type, payload) VALUES (${jobId}, 1, 'progress', '{}')`.execute(
            db,
          ),
        1062,
      );
    } finally {
      await sql`DELETE FROM render_job_event WHERE job_id = ${jobId}`.execute(db);
      await sql`DELETE FROM render_job WHERE id = ${jobId}`.execute(db);
    }
  }, 60_000);

  it('时间以 UTC 字面量进出，DATETIME(3) 毫秒精度不丢', async () => {
    const { rows } = await sql<{
      v: string;
    }>`SELECT CAST('2026-11-13 08:09:10.123' AS DATETIME(3)) AS v`.execute(db);
    expect(rows[0]?.v).toBe('2026-11-13 08:09:10.123');
    const { rows: tz } = await sql<{ tz: string }>`SELECT @@time_zone AS tz`.execute(db);
    expect(tz[0]?.tz).toBe('+00:00');
  });

  it('BIGINT 以字符串返回，>2^53 不静默丢精度', async () => {
    const { rows } = await sql<{
      v: string;
    }>`SELECT CAST(9007199254740993 AS UNSIGNED) AS v`.execute(db);
    expect(rows[0]?.v).toBe('9007199254740993');
  });

  it('DECIMAL 以字符串返回，计费不被浮点污染', async () => {
    const { rows } = await sql<{
      v: string;
    }>`SELECT CAST(0.1 AS DECIMAL(10,4)) + CAST(0.2 AS DECIMAL(10,4)) AS v`.execute(db);
    expect(rows[0]?.v).toBe('0.3000');
  });
});

describe('跨包冻结入口 · createDbClient 对真实 MySQL 的口径核验', () => {
  /** 由实测连接配置拼 URL（不硬编码凭据，随 env 变化）。 */
  function realUrl(): string {
    const c = handle.config;
    return `mysql://${encodeURIComponent(c.user)}:${encodeURIComponent(c.password)}@${c.host}:${String(c.port)}/${c.database}`;
  }

  it('冻结工厂产物的会话口径与内部 createDb 完全一致，且过门禁', async () => {
    const client = createDbClient({ url: realUrl(), connectionLimit: 2 });
    try {
      const caps = await assertServerCapabilities(client);
      const baseline = await assertServerCapabilities(db);
      expect(caps).toEqual(baseline);
      expect(dbHandleOf(client)?.initError).toBeNull();
    } finally {
      await client.destroy();
    }
  }, 60_000);

  it('charset utf8mb4 / collation utf8mb4_0900_ai_ci / time_zone +00:00 由会话实测', async () => {
    const client = createDbClient({ url: realUrl(), connectionLimit: 1 });
    try {
      const { rows } = await sql<{ cs: string; co: string; tz: string }>`
        SELECT @@character_set_client AS cs, @@collation_connection AS co, @@time_zone AS tz
      `.execute(client);
      expect(rows[0]?.cs).toBe('utf8mb4');
      expect(rows[0]?.co).toBe('utf8mb4_0900_ai_ci');
      expect(rows[0]?.tz).toBe('+00:00');
    } finally {
      await client.destroy();
    }
  }, 60_000);

  it('隔离级别是服务端的 READ-COMMITTED，客户端没有反着设', async () => {
    const client = createDbClient({ url: realUrl(), connectionLimit: 1 });
    try {
      const { rows } = await sql<{ s: string; g: string }>`
        SELECT @@session.transaction_isolation AS s, @@global.transaction_isolation AS g
      `.execute(client);
      expect(rows[0]?.s).toBe('READ-COMMITTED');
      expect(rows[0]?.g).toBe('READ-COMMITTED');
      // 会话值等于全局值 ⇒ 客户端未覆盖（若客户端反着设，两者会不同）
      expect(rows[0]?.s).toBe(rows[0]?.g);
    } finally {
      await client.destroy();
    }
  }, 60_000);

  it('返回值可直接当 Kysely<Database> 用：typed selectFrom 真的查到种子数据', async () => {
    const client = createDbClient({ url: realUrl(), connectionLimit: 1 });
    try {
      const works = await client
        .selectFrom('work')
        .select(['id', 'title'])
        .orderBy('created_at')
        .execute();
      expect(works).toHaveLength(3);
      expect(works.map((w) => w.title)).toContain('费曼学习法：为什么你学了就忘');
      // 列名以真实 DDL 为准：quota_account 只有 total/used/reserved，left 是推导量不是列
      const quota = await client
        .selectFrom('quota_account')
        .select(['total', 'used', 'reserved'])
        .where('user_id', '=', USER_ID)
        .executeTakeFirstOrThrow();
      expect(quota.total).toBe(60);
      expect(quota.used).toBe(22);
      expect(quota.reserved).toBe(0);
      expect(quota.total - quota.used - quota.reserved).toBe(38);
    } finally {
      await client.destroy();
    }
  }, 60_000);

  it('冻结入口看到的仍是恰好 36 张表，且无禁止表（未新增任何表）', async () => {
    const client = createDbClient({ url: realUrl(), connectionLimit: 1 });
    try {
      const tables = await listTables(client, handle.config.database);
      expect(tables).toHaveLength(TOTAL_TABLE_COUNT);
      expect([...tables].sort()).toEqual([...TABLE_ORDER].sort());
      for (const f of FORBIDDEN_TABLES) expect(tables).not.toContain(f);
    } finally {
      await client.destroy();
    }
  }, 60_000);

  it('destroy 真的关闭连接池（先查询后销毁）：后续查询失败且池标记 closed', async () => {
    const client = createDbClient({ url: realUrl(), connectionLimit: 1 });
    await client.selectFrom('work').select('id').limit(1).execute();
    await client.destroy();
    let caught: unknown;
    try {
      await sql`SELECT 1`.execute(client);
    } catch (e) {
      caught = e;
    }
    expect(caught, '销毁后仍能查询，说明池没被真正释放').toBeDefined();
    // _closed 是 mysql2 内部字段，此处仅作取证用（生产代码不读它）
    const pool = dbHandleOf(client)?.pool as unknown as { _closed?: boolean };
    expect(pool._closed).toBe(true);
  }, 60_000);

  it('已知生命周期口径（实测锁定）：从未查询就 destroy 不会关池，生产必须「先用后销」', async () => {
    const client = createDbClient({ url: realUrl(), connectionLimit: 1 });
    await client.destroy();
    const pool = dbHandleOf(client)?.pool as unknown as { _closed?: boolean };
    // Kysely 0.29.9 的 driver 是惰性 init：未 init 时 destroy 不调用 pool.end()，
    // 故池未标记 closed。这是库语义而非本包缺陷，用实测把它锁住，升级 Kysely 时会立刻暴露变化。
    expect(pool._closed).toBe(false);
    const rows = await client.selectFrom('work').select('id').limit(1).execute();
    expect(rows).toHaveLength(1);
    // 此时 driver 已 init，再 destroy 才真正关池
    await client.destroy();
    expect((dbHandleOf(client)?.pool as unknown as { _closed?: boolean })._closed).toBe(true);
  }, 60_000);
});
