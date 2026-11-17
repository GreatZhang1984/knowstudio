/**
 * T-03 运维入口：真实执行迁移 / 种子 / 逐表取证。
 *
 * 为什么需要它：package.json 不属于本工作包，无法加 script 条目，
 * 而 DoD 要求「迁移真的跑进 MySQL」且协调者要能**独立重跑**。
 * 故给出零依赖新增的调用方式（tsx 已在 node_modules/.bin 中）：
 *
 *   pnpm exec tsx packages/db/migrations/cli.ts capabilities
 *   pnpm exec tsx packages/db/migrations/cli.ts migrate
 *   pnpm exec tsx packages/db/migrations/cli.ts seed
 *   pnpm exec tsx packages/db/migrations/cli.ts show-create <输出文件>
 *   pnpm exec tsx packages/db/migrations/cli.ts verify
 *
 * 全部走 mysql2 over TCP，不使用 docker CLI（容器归协调者）。
 * 退出码：成功 0，任何断言失败非 0——不做「打印错误但返回 0」的假绿。
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { sql } from 'kysely';
import { createDb } from '../src/client.js';
import type { DbHandle } from '../src/client.js';
import { applySeed, loadSeedData, measureSeedCounts, seedId, SEED_EXPECTATIONS } from './seed.js';
import { listTables, migrate, DEFAULT_MIGRATIONS_DIR } from './runner.js';
import { TABLE_ORDER } from './tables.js';

/** SHOW CREATE TABLE 的真实返回形态（mysql2 列名随表名变化，故按索引取第二列）。 */
async function showCreate(handle: DbHandle, table: string): Promise<string> {
  const { rows } = await sql.raw<Record<string, unknown>>(`SHOW CREATE TABLE \`${table}\``).execute(handle.db);
  const row = rows[0];
  if (row === undefined) throw new Error(`SHOW CREATE TABLE ${table} 未返回行`);
  const values = Object.values(row);
  const ddl = values[1];
  if (typeof ddl !== 'string') throw new Error(`SHOW CREATE TABLE ${table} 第二列不是字符串`);
  return ddl;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const handle = createDb();
  try {
    switch (command) {
      case 'capabilities': {
        const { assertServerCapabilities } = await import('../src/client.js');
        const caps = await assertServerCapabilities(handle.db);
        process.stdout.write(`${JSON.stringify(caps, null, 2)}\n`);
        return;
      }
      case 'migrate': {
        const result = await migrate({ handle });
        process.stdout.write(
          `${JSON.stringify(
            {
              version: result.capabilities.version,
              tableCount: result.tableCount,
              applied: result.applied.map((m) => ({
                id: m.id,
                sha256: m.sha256,
                statementCount: m.statementCount,
                created: m.tablesCreated.length,
                skipped: m.tablesSkipped.length,
              })),
              skipped: result.skipped,
            },
            null,
            2,
          )}\n`,
        );
        return;
      }
      case 'seed': {
        const result = await applySeed({ handle });
        process.stdout.write(`${JSON.stringify({ applied: result.applied, userId: result.userId, counts: result.counts }, null, 2)}\n`);
        return;
      }
      case 'show-create': {
        const out = rest[0];
        if (out === undefined) throw new Error('用法：show-create <输出文件>');
        const tables = await listTables(handle.db, handle.config.database);
        const chunks: string[] = [];
        for (const t of TABLE_ORDER) {
          if (!tables.includes(t)) throw new Error(`表 ${t} 不存在，先跑 migrate`);
          chunks.push(`-- ===== ${t} =====\n${await showCreate(handle, t)};\n`);
        }
        writeFileSync(path.resolve(out), chunks.join('\n'), 'utf8');
        process.stdout.write(`已写出 ${String(TABLE_ORDER.length)} 张表的 SHOW CREATE TABLE → ${path.resolve(out)}\n`);
        return;
      }
      case 'compare': {
        const { readFileSync } = await import('node:fs');
        const { compareAll, compareTable } = await import('./ddl-compare.js');
        const { splitSqlStatements, createdTableName } = await import('./sql-split.js');
        const baseline = readFileSync(path.join(DEFAULT_MIGRATIONS_DIR, '0001_baseline.sql'), 'utf8');
        const expected = new Map<string, string>();
        for (const stmt of splitSqlStatements(baseline)) {
          const t = createdTableName(stmt);
          if (t !== null) expected.set(t, stmt);
        }
        const actual = new Map<string, string>();
        for (const t of TABLE_ORDER) actual.set(t, await showCreate(handle, t));
        const report = compareAll(expected, actual);
        // 逐表结论：DoD② 要求「每张表给结论」，不能只给一个总数
        for (const t of TABLE_ORDER) {
          const d = compareTable(expected.get(t) as string, actual.get(t) as string);
          process.stdout.write(`${d.equal ? 'OK  ' : 'DIFF'} ${t}\n`);
        }
        process.stdout.write(`逐表比对：${String(report.identical)}/${String(report.total)} 一致\n`);
        for (const d of report.diffs) {
          process.stdout.write(`\n=== ${d.table} ===\n`);
          for (const p of d.problems) process.stdout.write(`  - ${p}\n`);
        }
        if (report.identical !== report.total) process.exitCode = 1;
        return;
      }
      case 'counts': {
        const data = loadSeedData();
        const counts = await measureSeedCounts(handle.db, seedId('u', data.user.key));
        process.stdout.write(`${JSON.stringify({ counts, expectations: SEED_EXPECTATIONS }, null, 2)}\n`);
        return;
      }
      default:
        throw new Error(`未知命令：${String(command)}（capabilities|migrate|seed|show-create|compare|counts）`);
    }
  } finally {
    await handle.destroy();
  }
}

main().catch((err: unknown) => {
  const code = (err as { code?: unknown } | null)?.code;
  process.stderr.write(`[T-03] 失败 code=${String(code ?? 'UNKNOWN')}\n`);
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  const cause = (err as { cause?: unknown } | null)?.cause;
  if (cause !== undefined && cause !== null) {
    process.stderr.write(`cause: ${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}\n`);
  }
  process.exitCode = 1;
});