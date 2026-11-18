/**
 * 逐表比对器的**可信度证明**。
 *
 * 「37/37 一致」本身不构成证据——过度归一化也能得到全量一致。
 * 故本套件双向验证：
 *   A. 负向：对真实库 DDL 做 24 类**语义扰动**（改长度/类型/可空/默认值/CHECK/FK 动作/
 *      生成列表达式/索引列/多值索引长度/FULLTEXT parser/表引擎…），比对器**必须**报差异。
 *   B. 正向对照：只做**渲染变换**（反引号、数值默认值引号、字符集引导符、冗余括号、
 *      整型显示宽度、-> 与 json_extract 互换、版本门注释、FK 自动索引…），必须仍判一致。
 * 两者同时成立，才说明归一化「消掉了渲染噪声、留下了语义差异」。
 *
 * 取证文件 fixtures/live-show-create-table.sql 是 MySQL 8.4.13 的真实 SHOW CREATE TABLE 输出，
 * 由 `pnpm exec tsx packages/db/migrations/cli.ts show-create <file>` 生成；
 * mysql-integration.test.ts 会再证明它与**当前活库**逐字一致（防止取证文件过期）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  canonicalExpr,
  compareAll,
  compareTable,
  parseCreateTable,
  parseShowCreateDump,
  stripAutoIncrementCounter,
} from '../migrations/ddl-compare.js';
import { createdTableName, splitSqlStatements } from '../migrations/sql-split.js';
import { TABLE_ORDER, TOTAL_TABLE_COUNT } from '../migrations/tables.js';

const baselineText = readFileSync(
  fileURLToPath(new URL('../migrations/0001_baseline.sql', import.meta.url)),
  'utf8',
);
const migrationText = readFileSync(
  fileURLToPath(new URL('../migrations/0002_user_source_config.sql', import.meta.url)),
  'utf8',
);
const liveText = readFileSync(
  fileURLToPath(new URL('../../../fixtures/live-show-create-table.sql', import.meta.url)),
  'utf8',
);

const expected = new Map<string, string>();
for (const stmt of [...splitSqlStatements(baselineText), ...splitSqlStatements(migrationText)]) {
  const t = createdTableName(stmt);
  if (t !== null) expected.set(t, stmt);
}
const live = parseShowCreateDump(liveText);

const base = (table: string): string => expected.get(table) as string;
const liveOf = (table: string): string => live.get(table) as string;

/** 扰动必须真的命中原文，否则测试是空转（这是「假绿」的另一种形态）。 */
function mutate(table: string, from: string, to: string): string {
  const ddl = liveOf(table);
  expect(ddl, `取证文件缺少表 ${table}`).toBeDefined();
  expect(ddl, `扰动锚点未命中：${from}`).toContain(from);
  const out = ddl.replace(from, to);
  expect(out).not.toBe(ddl);
  return out;
}

function expectCaught(table: string, mutated: string, fragment?: string): void {
  const d = compareTable(base(table), mutated);
  expect(d.equal, `扰动未被识别为差异：${table}`).toBe(false);
  if (fragment !== undefined) expect(d.problems.join('\n')).toContain(fragment);
}

function expectStillEqual(table: string, mutated: string): void {
  const d = compareTable(base(table), mutated);
  expect(d.problems.join('\n')).toBe('');
  expect(d.equal).toBe(true);
}

describe('取证文件完整性', () => {
  it('解析出恰好 37 张表，表名与 TABLE_ORDER 一致', () => {
    expect(live.size).toBe(TOTAL_TABLE_COUNT);
    expect([...live.keys()].sort()).toEqual([...TABLE_ORDER].sort());
  });

  it('每条取证都是完整的 CREATE TABLE', () => {
    for (const [name, ddl] of live) {
      expect(ddl.startsWith('CREATE TABLE'), name).toBe(true);
      expect(createdTableName(ddl), name).toBe(name);
    }
  });

  it('架构基线加增量迁移也恰好 37 张，两侧表名集合相同', () => {
    expect(expected.size).toBe(TOTAL_TABLE_COUNT);
    expect([...expected.keys()].sort()).toEqual([...live.keys()].sort());
  });
});

describe('正向 · 架构基线 vs 真实库输出', () => {
  it('37/37 逐表一致', () => {
    const report = compareAll(expected, live);
    expect(report.total).toBe(TOTAL_TABLE_COUNT);
    expect(report.diffs.map((d) => `${d.table}: ${d.problems.join(' | ')}`)).toEqual([]);
    expect(report.identical).toBe(TOTAL_TABLE_COUNT);
  });

  it('自反性：每张表与自身比对必然一致', () => {
    for (const t of TABLE_ORDER) expect(compareTable(base(t), base(t)).equal).toBe(true);
  });
});

describe('结构抽查 · 防止「两侧同样错」造成的假绿', () => {
  it('idempotency_record 的保留字列 `key` 被识别为列而非索引', () => {
    for (const ddl of [base('idempotency_record'), liveOf('idempotency_record')]) {
      const shape = parseCreateTable(ddl);
      expect(shape.columns.map((c) => c.name)).toEqual([
        'user_id',
        'key',
        'request_hash',
        'status_code',
        'response',
        'created_at',
      ]);
      expect(shape.keys).toEqual(['primary key (user_id,key)']);
    }
  });

  it('render_job 的 active_render_flag 是 STORED 生成列（并发上限的唯一防线）', () => {
    const shape = parseCreateTable(liveOf('render_job'));
    const col = shape.columns.find((c) => c.name === 'active_render_flag');
    expect(col?.canonical).toContain('generated always as');
    expect(col?.canonical).toContain('stored');
    expect(col?.canonical).toContain("status in ('queued','running')");
    expect(shape.keys.some((k) => k.includes('uq_active_render_per_user'))).toBe(true);
  });

  it('script_line.char_count 是 STORED 生成列，表达式为 char_length', () => {
    const col = parseCreateTable(liveOf('script_line')).columns.find(
      (c) => c.name === 'char_count',
    );
    expect(col?.canonical).toBe('char_count int generated always as (char_length(text)) stored');
  });

  it('material 的多值索引保留 ARRAY 与 CHAR(64)', () => {
    const shape = parseCreateTable(liveOf('material'));
    expect(shape.keys).toContain('key ix_material_tags ((cast(tags as char(64) array)))');
  });

  it('work 的 FULLTEXT 使用 ngram parser', () => {
    const shape = parseCreateTable(liveOf('work'));
    expect(
      shape.keys.some(
        (k) => k.startsWith('fulltext key ft_work_title') && k.includes('with parser ngram'),
      ),
    ).toBe(true);
  });

  it('quota_account 的四条 CHECK 都在（超支兜底）', () => {
    const cs = parseCreateTable(liveOf('quota_account')).constraints;
    expect(cs.some((c) => c.includes('ck_quota_no_overdraft'))).toBe(true);
    expect(cs.some((c) => c.includes('ck_quota_reserved'))).toBe(true);
    expect(cs.some((c) => c.includes('ck_quota_total'))).toBe(true);
    expect(cs.some((c) => c.includes('ck_quota_used'))).toBe(true);
  });

  it('app_user 的 password_hash 可空且 phone/email 唯一键与 CHECK 都在（DDL 不得改动）', () => {
    const shape = parseCreateTable(liveOf('app_user'));
    expect(shape.columns.find((c) => c.name === 'password_hash')?.canonical).toBe(
      'password_hash varchar(255) default null',
    );
    expect(shape.keys).toContain('unique key uq_user_phone (phone)');
    expect(shape.keys).toContain('unique key uq_user_email (email)');
    expect(shape.constraints.some((c) => c.includes('ck_user_contact'))).toBe(true);
  });
});

describe('负向 · 语义扰动必须被识别', () => {
  it('列长度变化 varchar(120)→varchar(121)', () => {
    expectCaught(
      'app_user',
      mutate('app_user', '`name` varchar(120) NOT NULL', '`name` varchar(121) NOT NULL'),
      '列 name 定义不同',
    );
  });

  it('主键类型长度变化 char(36)→char(32)', () => {
    expectCaught(
      'app_user',
      mutate('app_user', '`id` char(36) CHARACTER SET ascii', '`id` char(32) CHARACTER SET ascii'),
      '列 id 定义不同',
    );
  });

  it('可空性变化 NOT NULL→可空', () => {
    expectCaught(
      'app_user',
      mutate('app_user', '`name` varchar(120) NOT NULL', '`name` varchar(120) DEFAULT NULL'),
      '列 name 定义不同',
    );
  });

  it('字符串默认值变化 creator_168→creator_999', () => {
    expectCaught(
      'app_user',
      mutate('app_user', "DEFAULT 'creator_168'", "DEFAULT 'creator_999'"),
      '列 plan_id 定义不同',
    );
  });

  it('数值默认值变化 0→1', () => {
    expectCaught(
      'work',
      mutate(
        'work',
        "`phase` tinyint NOT NULL DEFAULT '0'",
        "`phase` tinyint NOT NULL DEFAULT '1'",
      ),
      '列 phase 定义不同',
    );
  });

  it('DECIMAL 默认值变化 1.00→1.01', () => {
    expectCaught(
      'video_asset',
      mutate('video_asset', "DEFAULT '1.00'", "DEFAULT '1.01'"),
      '列 speed 定义不同',
    );
  });

  it('DECIMAL 精度变化 (3,2)→(4,2)', () => {
    expectCaught(
      'video_asset',
      mutate('video_asset', '`speed` decimal(3,2)', '`speed` decimal(4,2)'),
      '列 speed 定义不同',
    );
  });

  it('JSON 表达式默认值变化 json_array()→json_object()', () => {
    expectCaught(
      'app_user',
      mutate(
        'app_user',
        '`domain_prefs` json NOT NULL DEFAULT (json_array())',
        '`domain_prefs` json NOT NULL DEFAULT (json_object())',
      ),
      '列 domain_prefs 定义不同',
    );
  });

  it('JSON 默认值内容变化（默认平台列表）', () => {
    expectCaught(
      'app_user',
      mutate('app_user', '\'["douyin","sph","bili","xhs"]\'', '\'["douyin","sph","bili"]\''),
      '列 default_platforms 定义不同',
    );
  });

  it('删除 CHECK 约束（ck_user_contact）', () => {
    const ddl = liveOf('app_user').replace(
      /,\n {2}CONSTRAINT `ck_user_contact` CHECK [^\n]*\n/,
      '\n',
    );
    expect(ddl).not.toBe(liveOf('app_user'));
    expectCaught('app_user', ddl, 'ck_user_contact');
  });

  it('篡改 CHECK 边界 between 0 and 4 → 0 and 5', () => {
    expectCaught(
      'work',
      mutate('work', '`phase` between 0 and 4', '`phase` between 0 and 5'),
      'ck_work_phase',
    );
  });

  it('篡改配额超支 CHECK：<= 改成 <（会误拒合法满额）', () => {
    expectCaught(
      'quota_account',
      mutate(
        'quota_account',
        '(`used` + `reserved`) <= `total`',
        '(`used` + `reserved`) < `total`',
      ),
      'ck_quota_no_overdraft',
    );
  });

  it('列 collation 变化 ascii_bin→ascii_general_ci（FK 两端不一致的根因）', () => {
    expectCaught(
      'app_user',
      mutate(
        'app_user',
        '`id` char(36) CHARACTER SET ascii COLLATE ascii_bin',
        '`id` char(36) CHARACTER SET ascii COLLATE ascii_general_ci',
      ),
      '列 id 定义不同',
    );
  });

  it('列字符集变化 ascii→utf8mb4', () => {
    expectCaught(
      'app_user',
      mutate(
        'app_user',
        '`id` char(36) CHARACTER SET ascii COLLATE ascii_bin',
        '`id` char(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin',
      ),
      '列 id 定义不同',
    );
  });

  it('FK 动作变化 ON DELETE CASCADE→SET NULL', () => {
    expectCaught(
      'style_sample',
      mutate(
        'style_sample',
        'REFERENCES `app_user` (`id`) ON DELETE CASCADE',
        'REFERENCES `app_user` (`id`) ON DELETE SET NULL',
      ),
      'fk_sample_user',
    );
  });

  it('FK 引用表变化 app_user→work', () => {
    expectCaught(
      'style_sample',
      mutate('style_sample', 'REFERENCES `app_user` (`id`)', 'REFERENCES `work` (`id`)'),
      'fk_sample_user',
    );
  });

  it('删除整条 FK 约束', () => {
    const ddl = liveOf('style_sample').replace(
      /,\n {2}CONSTRAINT `fk_sample_user` FOREIGN KEY [^\n]*\n/,
      '\n',
    );
    expect(ddl).not.toBe(liveOf('style_sample'));
    expectCaught('style_sample', ddl, 'fk_sample_user');
  });

  it('生成列表达式变化 char_length→length（字节数≠字数，中文会算错）', () => {
    expectCaught(
      'script_line',
      mutate('script_line', 'AS (char_length(`text`))', 'AS (length(`text`))'),
      'char_count',
    );
  });

  it('生成列 STORED→VIRTUAL（唯一索引与并发防线依赖 STORED）', () => {
    expectCaught(
      'script_line',
      mutate('script_line', 'AS (char_length(`text`)) STORED', 'AS (char_length(`text`)) VIRTUAL'),
      'char_count',
    );
  });

  it('并发上限生成列条件被放宽（去掉 type 限定）', () => {
    const from = "(`type` in (_utf8mb4'draft',_utf8mb4'hd',_utf8mb4'patch'))";
    expectCaught('render_job', mutate('render_job', from, '(1=1)'), 'active_render_flag');
  });

  it('删除索引 ix_work_user_phase', () => {
    const ddl = liveOf('work').replace(/ {2}KEY `ix_work_user_phase` [^\n]*\n/, '');
    expect(ddl).not.toBe(liveOf('work'));
    expectCaught('work', ddl, 'ix_work_user_phase');
  });

  it('索引列顺序变化（user_id,phase → phase,user_id）', () => {
    expectCaught(
      'work',
      mutate(
        'work',
        'KEY `ix_work_user_phase` (`user_id`,`phase`)',
        'KEY `ix_work_user_phase` (`phase`,`user_id`)',
      ),
      'ix_work_user_phase',
    );
  });

  it('索引排序方向变化 DESC→ASC（影响「最近作品」查询口径）', () => {
    expectCaught(
      'work',
      mutate('work', '`updated_at` DESC)', '`updated_at` ASC)'),
      'ix_work_user_active',
    );
  });

  it('新增架构未声明的索引', () => {
    expectCaught(
      'work',
      mutate('work', '  PRIMARY KEY (`id`),', '  PRIMARY KEY (`id`),\n  KEY `ix_bogus` (`title`),'),
      'ix_bogus',
    );
  });

  it('FULLTEXT 去掉 ngram parser（中文检索会静默失效）', () => {
    const ddl = liveOf('work').replace(' /*!50100 WITH PARSER `ngram` */', '');
    expect(ddl).not.toBe(liveOf('work'));
    expectCaught('work', ddl, 'ft_work_title');
  });

  it('FULLTEXT 覆盖列变化（title → title,body_text）', () => {
    expectCaught(
      'work',
      mutate(
        'work',
        'FULLTEXT KEY `ft_work_title` (`title`)',
        'FULLTEXT KEY `ft_work_title` (`title`,`keyword`)',
      ),
      'ft_work_title',
    );
  });

  it('多值索引长度变化 CHAR(64)→CHAR(32)', () => {
    expectCaught(
      'material',
      mutate('material', 'cast(`tags` as char(64) array)', 'cast(`tags` as char(32) array)'),
      'ix_material_tags',
    );
  });

  it('多值索引退化为普通索引（去掉 ARRAY）', () => {
    expectCaught(
      'material',
      mutate('material', '((cast(`tags` as char(64) array)))', '(`tags`(64))'),
      'ix_material_tags',
    );
  });

  it('ENUM 取值变化（新增一个未声明的状态）', () => {
    expectCaught(
      'work',
      mutate('work', "'video.rendered','derive'", "'video.rendered','published','derive'"),
      '列 step 定义不同',
    );
  });

  it('删除一列', () => {
    const ddl = liveOf('app_user').replace(/ {2}`theme` [^\n]*\n/, '');
    expect(ddl).not.toBe(liveOf('app_user'));
    expectCaught('app_user', ddl, '列数不同');
  });

  it('新增一列', () => {
    expectCaught(
      'app_user',
      mutate(
        'app_user',
        '  PRIMARY KEY (`id`),',
        '  `extra` int DEFAULT NULL,\n  PRIMARY KEY (`id`),',
      ),
      '列数不同',
    );
  });

  it('列顺序变化（ ordinal 位置是语义的一部分）', () => {
    const ddl = liveOf('app_user')
      .replace('  `phone` varchar(32) DEFAULT NULL,\n', '')
      .replace(
        '  `email` varchar(255) DEFAULT NULL,\n',
        '  `email` varchar(255) DEFAULT NULL,\n  `phone` varchar(32) DEFAULT NULL,\n',
      );
    expect(ddl).not.toBe(liveOf('app_user'));
    expectCaught('app_user', ddl, '列名不同');
  });

  it('表引擎变化 InnoDB→MyISAM（事务与 FK 全失效）', () => {
    expectCaught('app_user', mutate('app_user', 'ENGINE=InnoDB', 'ENGINE=MyISAM'), '表选项不同');
  });

  it('表默认排序规则变化 utf8mb4_0900_ai_ci→utf8mb4_general_ci', () => {
    expectCaught(
      'app_user',
      mutate('app_user', 'COLLATE=utf8mb4_0900_ai_ci', 'COLLATE=utf8mb4_general_ci'),
      '表选项不同',
    );
  });

  it('唯一键退化为普通索引（phone 可重复）', () => {
    expectCaught(
      'app_user',
      mutate('app_user', 'UNIQUE KEY `uq_user_phone`', 'KEY `uq_user_phone`'),
      'uq_user_phone',
    );
  });
});

describe('正向对照 · 纯渲染变换必须仍判一致', () => {
  it('去掉全部反引号', () => {
    expectStillEqual('app_user', liveOf('app_user').replace(/`/g, ''));
  });

  it("数值默认值去引号 DEFAULT '0' → DEFAULT 0", () => {
    expectStillEqual(
      'work',
      mutate('work', "`phase` tinyint NOT NULL DEFAULT '0'", '`phase` tinyint NOT NULL DEFAULT 0'),
    );
  });

  it('DECIMAL 默认值去引号', () => {
    expectStillEqual('video_asset', mutate('video_asset', "DEFAULT '1.00'", 'DEFAULT 1.00'));
  });

  it('补上字符集引导符 _utf8mb4', () => {
    expectStillEqual(
      'app_user',
      mutate('app_user', "DEFAULT 'creator_168'", "DEFAULT _utf8mb4'creator_168'"),
    );
  });

  it('CHECK 补冗余括号', () => {
    expectStillEqual(
      'work',
      mutate(
        'work',
        'CHECK ((`phase` between 0 and 4))',
        'CHECK (((((`phase` between 0 and 4)))))',
      ),
    );
  });

  it('整型补显示宽度 tinyint→tinyint(4)', () => {
    expectStillEqual(
      'work',
      mutate('work', '`phase` tinyint NOT NULL', '`phase` tinyint(4) NOT NULL'),
    );
  });

  it('tinyint(1) 的 BOOL 语义不被显示宽度归一化吃掉', () => {
    // tinyint(1) 与 tinyint 是**不同**的列类型（BOOL vs 整数），必须报差异
    expectCaught(
      'style_profile',
      mutate('style_profile', '`is_default` tinyint(1)', '`is_default` tinyint'),
      'is_default',
    );
  });

  it('json_extract 与 -> 运算符互换', () => {
    expectStillEqual(
      'work_material',
      mutate(
        'work_material',
        "cast(json_extract(`used_in`,_utf8mb4'$[*].target') as char(16) array)",
        "cast(`used_in`->'$[*].target' as char(16) array)",
      ),
    );
  });

  it('版本门注释解包后仍一致', () => {
    expectStillEqual(
      'work',
      mutate('work', '/*!50100 WITH PARSER `ngram` */', 'WITH PARSER ngram'),
    );
  });

  it('只写 COLLATE 时省略推导出的 CHARACTER SET', () => {
    expectStillEqual(
      'app_user',
      mutate(
        'app_user',
        '`id` char(36) CHARACTER SET ascii COLLATE ascii_bin',
        '`id` char(36) COLLATE ascii_bin',
      ),
    );
  });

  it('移除 MySQL 为 FK 自动补建的索引', () => {
    const ddl = liveOf('render_job').replace(/ {2}KEY `fk_job_video` [^\n]*\n/, '');
    expect(ddl).not.toBe(liveOf('render_job'));
    expectStillEqual('render_job', ddl);
  });

  it('表选项补 AUTO_INCREMENT 计数器（空表与有数据的表天然不同）', () => {
    expectStillEqual(
      'render_job_event',
      mutate('render_job_event', 'ENGINE=InnoDB', 'ENGINE=InnoDB AUTO_INCREMENT=42'),
    );
  });

  it('索引与约束声明顺序重排（按集合比，不按顺序）', () => {
    const ddl = liveOf('app_user');
    const phone = '  UNIQUE KEY `uq_user_phone` (`phone`),\n';
    const email = '  UNIQUE KEY `uq_user_email` (`email`),\n';
    expect(ddl).toContain(phone);
    expect(ddl).toContain(email);
    expectStillEqual('app_user', ddl.replace(phone, '').replace(email, `${email}${phone}`));
  });

  it('关键字大小写变化', () => {
    expectStillEqual(
      'app_user',
      liveOf('app_user')
        .replace(/NOT NULL/g, 'not null')
        .replace(/DEFAULT/g, 'default'),
    );
  });
});

describe('FK 自动索引抵消的精确性 · 不得变成「忽略一切多余索引」', () => {
  it('索引名与 FK 同名但列不同 → 必须报差异', () => {
    expectCaught(
      'render_job',
      mutate(
        'render_job',
        'KEY `fk_job_video` (`video_asset_id`)',
        'KEY `fk_job_video` (`work_id`)',
      ),
      'fk_job_video',
    );
  });

  it('FK 自动索引被加上额外列 → 必须报差异', () => {
    expectCaught(
      'render_job',
      mutate(
        'render_job',
        'KEY `fk_job_video` (`video_asset_id`)',
        'KEY `fk_job_video` (`video_asset_id`,`user_id`)',
      ),
      'fk_job_video',
    );
  });

  it('与任何 FK 都无关的多余索引 → 必须报差异', () => {
    expectCaught(
      'render_job',
      mutate(
        'render_job',
        '  PRIMARY KEY (`id`),',
        '  PRIMARY KEY (`id`),\n  KEY `fk_not_declared` (`user_id`),',
      ),
      'fk_not_declared',
    );
  });
});

describe('canonicalExpr · 表达式规范化', () => {
  it('消解冗余括号', () => {
    expect(canonicalExpr('(((a + b) <= c))')).toBe('a + b <= c');
  });
  it('保留改变语义的括号', () => {
    expect(canonicalExpr('a + (b * c)')).toBe('a + b * c');
    expect(canonicalExpr('(a + b) * c')).toBe('(a + b) * c');
  });
  it('IS NOT NULL / OR 小写化', () => {
    expect(canonicalExpr('((`phone` IS NOT NULL) OR (`email` IS NOT NULL))')).toBe(
      'phone is not null or email is not null',
    );
  });
  it('IN 列表与 AND 组合', () => {
    expect(
      canonicalExpr("((`status` IN ('queued','running')) AND (`type` IN ('draft','hd')))"),
    ).toBe("status in ('queued','running') and type in ('draft','hd')");
  });
  it('BETWEEN 边界', () => {
    expect(canonicalExpr('(`phase` BETWEEN 0 AND 4)')).toBe('phase between 0 and 4');
  });
  it('字符集引导符被剥离', () => {
    expect(canonicalExpr("_utf8mb4'cleared'")).toBe("'cleared'");
  });
  it('-> 重写为 json_extract', () => {
    expect(canonicalExpr("used_in->'$[*].target'")).toBe("json_extract(used_in,'$[*].target')");
  });
  it('->> 再套 json_unquote', () => {
    expect(canonicalExpr("used_in->>'$[*].target'")).toBe(
      "json_unquote(json_extract(used_in,'$[*].target'))",
    );
  });
  it('CAST 的类型部分按原样保留（含 ARRAY）', () => {
    expect(canonicalExpr('CAST(tags AS CHAR(64) ARRAY)')).toBe('cast(tags as char(64) array)');
  });
  it('数值字面量去引号，TRUE/FALSE 归一', () => {
    expect(canonicalExpr("'1.00'")).toBe('1.00');
    expect(canonicalExpr('TRUE')).toBe('1');
    expect(canonicalExpr('FALSE')).toBe('0');
  });
  it('字符串字面量大小写不被折叠', () => {
    expect(canonicalExpr("'Creator_168'")).toBe("'Creator_168'");
  });
  it('函数调用参数逗号归一', () => {
    expect(canonicalExpr('IF( (a),1 , NULL )')).toBe('if(a,1,null)');
  });
});

describe('stripAutoIncrementCounter · 只抹数据态计数器，不得抹掉 schema', () => {
  const BODY =
    'CREATE TABLE `t` (\n  `id` bigint NOT NULL AUTO_INCREMENT,\n  `k` varchar(64) NOT NULL,\n  PRIMARY KEY (`id`)\n)';
  const opts = (s: string): string =>
    `${BODY} ENGINE=InnoDB${s} DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`;

  it('抹掉表选项计数器，其余逐字保留', () => {
    expect(stripAutoIncrementCounter(opts(' AUTO_INCREMENT=13'))).toBe(opts(''));
  });
  it('计数器在末尾（无后续选项）也能抹掉且不留尾随空白', () => {
    const ddl = `${BODY} ENGINE=InnoDB AUTO_INCREMENT=99`;
    expect(stripAutoIncrementCounter(ddl)).toBe(`${BODY} ENGINE=InnoDB`);
  });
  it('无计数器时是恒等变换（含空表形态）', () => {
    const ddl = opts('');
    expect(stripAutoIncrementCounter(ddl)).toBe(ddl);
  });
  it('列上的 AUTO_INCREMENT 属性属于 schema，必须保留', () => {
    expect(stripAutoIncrementCounter(opts(' AUTO_INCREMENT=7'))).toContain(
      '`id` bigint NOT NULL AUTO_INCREMENT,',
    );
  });
  it('大小写与等号两侧空白不影响识别', () => {
    expect(
      stripAutoIncrementCounter(
        `${BODY} engine=InnoDB auto_increment = 42 DEFAULT CHARSET=utf8mb4`,
      ),
    ).toBe(`${BODY} engine=InnoDB DEFAULT CHARSET=utf8mb4`);
  });
  it('引号内（表 COMMENT）的同名文本不得被误删', () => {
    const ddl = `${BODY} ENGINE=InnoDB AUTO_INCREMENT=5 COMMENT='AUTO_INCREMENT=5 是文档示例'`;
    expect(stripAutoIncrementCounter(ddl)).toBe(
      `${BODY} ENGINE=InnoDB COMMENT='AUTO_INCREMENT=5 是文档示例'`,
    );
  });
  it('列定义区里出现的同名文本不受影响（只动表选项区）', () => {
    const ddl = `CREATE TABLE \`t\` (\n  \`note\` varchar(64) NOT NULL DEFAULT 'AUTO_INCREMENT=5'\n) ENGINE=InnoDB AUTO_INCREMENT=2`;
    expect(stripAutoIncrementCounter(ddl)).toBe(
      `CREATE TABLE \`t\` (\n  \`note\` varchar(64) NOT NULL DEFAULT 'AUTO_INCREMENT=5'\n) ENGINE=InnoDB`,
    );
  });
  it('非 SHOW CREATE TABLE 多行形态原样返回，不猜', () => {
    const one = 'CREATE TABLE `t` (`id` int) ENGINE=InnoDB AUTO_INCREMENT=3';
    expect(stripAutoIncrementCounter(one)).toBe(one);
  });
  it('负向：抹除后真实 schema 差异仍然暴露（不是把两侧一起抹平）', () => {
    const live = opts(' AUTO_INCREMENT=13');
    const fixture = opts('');
    expect(stripAutoIncrementCounter(live)).toBe(fixture);
    const mutated = fixture.replace('varchar(64)', 'varchar(63)');
    expect(mutated).not.toBe(fixture);
    expect(stripAutoIncrementCounter(live)).not.toBe(mutated);
    expect(compareTable(mutated, stripAutoIncrementCounter(live)).equal).toBe(false);
  });
  it('取证文件 36 张表本身都不含计数器（纯 schema 快照）', () => {
    expect(live.size).toBe(TOTAL_TABLE_COUNT);
    for (const [t, ddl] of live) {
      expect(stripAutoIncrementCounter(ddl), t).toBe(ddl);
    }
  });
});
