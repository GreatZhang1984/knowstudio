/**
 * SQL 切分器单测。重点覆盖**真实基线里就存在**的陷阱：
 * 头部注释带分号、列注释带单引号。朴素 split(';') 会在这里把 DDL 切碎。
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  createdTableName,
  scanSql,
  splitSqlStatements,
  stripSqlComments,
} from '../migrations/sql-split.js';
import { TABLE_ORDER, TOTAL_TABLE_COUNT } from '../migrations/tables.js';

const BASELINE_PATH = fileURLToPath(new URL('../migrations/0001_baseline.sql', import.meta.url));
const baseline = readFileSync(BASELINE_PATH, 'utf8');

describe('scanSql · 注释优先于引号', () => {
  it('头部注释里的分号不算语句边界（真实基线陷阱）', () => {
    const sql = "-- 前置：SET NAMES utf8mb4; 连接 time_zone='+00:00';\nCREATE TABLE a (id INT);";
    const { boundaries } = scanSql(sql);
    // 只有 CREATE TABLE 结尾那一个分号
    expect(boundaries).toHaveLength(1);
    expect(sql[boundaries[0] as number]).toBe(';');
    expect(boundaries[0]).toBe(sql.length - 1);
  });

  it('注释里的单引号不会开启字符串，从而不会吞掉后续分号', () => {
    const sql = "-- '9:16' | '16:9'\nCREATE TABLE a (id INT); CREATE TABLE b (id INT);";
    expect(scanSql(sql).boundaries).toHaveLength(2);
    expect(splitSqlStatements(sql)).toHaveLength(2);
  });

  it('列注释里的 JSON 样例引号不影响切分', () => {
    const sql = "CREATE TABLE a (\n  x JSON -- [{target:'slides',pageId:'p2'}]\n);";
    const stmts = splitSqlStatements(sql);
    expect(stmts).toHaveLength(1);
    expect(stmts[0]).toContain("pageId:'p2'");
  });

  it('`--` 后无空白是减号运算符，不是注释（MySQL 语义）', () => {
    const sql = 'SELECT 1--2;';
    expect(scanSql(sql).comments).toHaveLength(0);
    expect(scanSql(sql).boundaries).toHaveLength(1);
  });

  it('`--` 后紧跟行尾也算注释', () => {
    expect(scanSql('SELECT 1; --').comments).toHaveLength(1);
  });

  it('# 行注释被识别', () => {
    expect(scanSql('# hi; there\nSELECT 1;').boundaries).toHaveLength(1);
  });

  it('字符串内的分号与注释符都不是边界', () => {
    const sql = "INSERT INTO a VALUES ('x;--y');";
    expect(scanSql(sql).boundaries).toHaveLength(1);
    expect(splitSqlStatements(sql)).toHaveLength(1);
  });

  it('双写引号转义不会提前结束字符串', () => {
    const sql = "INSERT INTO a VALUES ('it''s; ok');";
    expect(scanSql(sql).boundaries).toHaveLength(1);
  });

  it('反斜杠转义不会提前结束字符串', () => {
    const sql = "INSERT INTO a VALUES ('a\\';b');";
    expect(scanSql(sql).boundaries).toHaveLength(1);
  });

  it('反引号标识符内的引号与分号被当作普通字符', () => {
    const sql = "CREATE TABLE `odd;name'x` (id INT);";
    expect(scanSql(sql).boundaries).toHaveLength(1);
    expect(createdTableName(sql)).toBe("odd;name'x");
  });

  it('反引号内反斜杠不是转义符', () => {
    const sql = 'CREATE TABLE `a\\b` (id INT);';
    expect(scanSql(sql).boundaries).toHaveLength(1);
    expect(createdTableName(sql)).toBe('a\\b');
  });
});

describe('stripSqlComments · 等长替换', () => {
  it('长度不变且保留换行，便于下标定位', () => {
    const sql = '-- hi\nSELECT 1;';
    const stripped = stripSqlComments(sql);
    expect(stripped).toHaveLength(sql.length);
    expect(stripped).toBe('     \nSELECT 1;');
  });

  it('无注释时原样返回', () => {
    const sql = 'SELECT 1;';
    expect(stripSqlComments(sql)).toBe(sql);
  });
});

describe('splitSqlStatements · 纯注释片段被丢弃', () => {
  it('文件头与表间说明不会变成空语句', () => {
    const sql = '-- header\n\nCREATE TABLE a (id INT);\n\n-- between\n\nCREATE TABLE b (id INT);\n';
    const stmts = splitSqlStatements(sql);
    expect(stmts).toHaveLength(2);
    // 返回的是**原文切片**（刻意保留注释，保证发给 MySQL 的文本与架构 DDL 一致），
    // 故断言表名而不是 startsWith——前导注释属于设计行为。
    expect(stmts.map((s) => createdTableName(s))).toEqual(['a', 'b']);
  });

  it('结尾无分号的语句也能取到', () => {
    expect(splitSqlStatements('CREATE TABLE a (id INT)')).toHaveLength(1);
  });

  it('去掉结尾分号与首尾空白', () => {
    expect(splitSqlStatements('  CREATE TABLE a (id INT);  ')).toEqual(['CREATE TABLE a (id INT)']);
  });

  it('空文本返回空数组', () => {
    expect(splitSqlStatements('')).toEqual([]);
    expect(splitSqlStatements('-- only comment\n')).toEqual([]);
  });
});

describe('createdTableName', () => {
  it('识别反引号表名', () => {
    expect(createdTableName('CREATE TABLE `app_user` (id INT)')).toBe('app_user');
  });
  it('识别裸表名与 IF NOT EXISTS', () => {
    expect(createdTableName('CREATE TABLE IF NOT EXISTS work (id INT)')).toBe('work');
  });
  it('忽略大小写', () => {
    expect(createdTableName('create table Work (id int)')).toBe('Work');
  });
  it('注释里的同名词不干扰', () => {
    expect(createdTableName('-- CREATE TABLE fake (x int)\nCREATE TABLE real_t (id INT)')).toBe('real_t');
  });
  it('非 CREATE TABLE 返回 null', () => {
    expect(createdTableName('ALTER TABLE a ADD COLUMN b INT')).toBeNull();
    expect(createdTableName('INSERT INTO a VALUES (1)')).toBeNull();
  });
});

describe('真实基线 0001_baseline.sql', () => {
  it('恰好切出 36 条语句，且每条都是 CREATE TABLE', () => {
    const stmts = splitSqlStatements(baseline);
    expect(stmts).toHaveLength(TOTAL_TABLE_COUNT);
    for (const s of stmts) expect(createdTableName(s)).not.toBeNull();
  });

  it('切出的表名集合与 TABLE_ORDER 完全一致（顺序也一致）', () => {
    const names = splitSqlStatements(baseline).map((s) => createdTableName(s));
    expect(names).toEqual([...TABLE_ORDER]);
  });

  it('无 CRLF：账本 sha256 按原文计算，换行风格漂移会破坏幂等', () => {
    expect(baseline.includes('\r')).toBe(false);
  });

  it('sha256 锁定与架构 §4.4 的逐字节一致性', () => {
    const sha = createHash('sha256').update(baseline, 'utf8').digest('hex');
    expect(sha).toBe('2da4a7b4d531bb43247fe42c3e90e3fadd97084b1e25b52a7280c6c31eafab8f');
  });

  it('36 条 CREATE TABLE 与 36 张表一一对应，无重复', () => {
    const names = splitSqlStatements(baseline).map((s) => createdTableName(s) as string);
    expect(new Set(names).size).toBe(TOTAL_TABLE_COUNT);
  });
});