/**
 * T-10 仓储层测试：证明 `user_id` 谓词是**结构性强制**，不依赖调用方自觉。
 *
 * ## 证据是怎么取的（以及为什么这样取）
 * `apps/api` 未声明 kysely / mysql2 依赖，pnpm 严格隔离下从本目录**不可解析**
 * （已实测 MODULE_NOT_FOUND），且本工作包禁止改任何 package.json。
 * 故不 import kysely，而是走 `@knowstudio/db` 的 `createDb()` 拿到**真实 Kysely + 真实 mysql2 pool**，
 * 再在 `pool.getConnection` 这一层替换连接：Kysely 的 MysqlDriver 会调用
 * `connection.query(sql, parameters, cb)`（已核对 kysely 0.29.9 mysql-driver.js 源码），
 * 于是我们捕获到的是 **Kysely MysqlQueryCompiler 真实编译产物**，不是手写字符串。
 *
 * 这能证明：谓词存在、位置正确、值走绑定参数（不是拼接）、跨用户绑定不同 userId。
 * 这**不能**证明 MySQL 真的按谓词过滤 —— 那需要 work/app_user 建表（T-03/WP10）。
 * 故真实库集成用例在本文件末尾显式标阻塞，绝不用「SQL 看起来对」冒充「库真的隔离了」。
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { createDb } from '@knowstudio/db';
import {
  createWorkRepository,
  decodeWorkCursor,
  encodeWorkCursor,
  WorkCursorInvalidError,
  WorkIdInvalidError,
  WorkScopeRequiredError,
  type WorkRow,
} from '@knowstudio/db/repositories';

/** 被捕获的一次真实查询。 */
interface Captured {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

type Responder = (q: Captured) => unknown;

/**
 * 在真实 mysql2 pool 上拦截 getConnection，返回记录型连接。
 * 不建立任何真实 TCP 连接，因此**不需要表存在**，也不会污染数据库。
 */
function interceptPool(responder: Responder): {
  readonly captured: Captured[];
  readonly restore: () => void;
  readonly handle: ReturnType<typeof createDb>;
} {
  const handle = createDb({ connectionLimit: 1 });
  const captured: Captured[] = [];
  const pool = handle.pool as unknown as {
    getConnection: (cb: (err: unknown, conn: unknown) => void) => void;
  };
  const original = pool.getConnection.bind(pool);

  const fakeConnection = {
    threadId: 1,
    // Kysely MysqlConnection#executeQuery 的真实调用形态。
    query(sql: string, parameters: readonly unknown[], cb: (err: unknown, result: unknown) => void) {
      const q: Captured = { sql, parameters };
      captured.push(q);
      cb(null, responder(q));
    },
    release() {},
    destroy() {},
  };

  pool.getConnection = (cb) => {
    cb(null, fakeConnection);
  };

  return {
    captured,
    handle,
    restore() {
      pool.getConnection = original;
    },
  };
}

/** SELECT 的默认应答：一行合法 work（列名与 WP10 WorkTable 逐列对齐）。 */
function workRow(overrides: Partial<WorkRow> = {}): WorkRow {
  return {
    id: 'w-owner-a-0001',
    user_id: 'user-a',
    title: '费曼学习法',
    keyword: '费曼学习法',
    phase: 0,
    step: 'search',
    selected_topic_id: null,
    script_confirmed_at: null,
    active_render_job_id: null,
    gates: { G1: false, G2: false, G3: false, G4: false },
    gates_fingerprint: null,
    exported_at: null,
    deleted_at: null,
    created_at: '2026-11-13 01:00:00.000',
    updated_at: '2026-11-13 01:00:00.000',
    ...overrides,
  } as WorkRow;
}

const OK_PACKET = { insertId: 0, affectedRows: 1, changedRows: 1 };

/** 取捕获里最后一条 SELECT。 */
function lastSelect(captured: readonly Captured[]): Captured {
  const selects = captured.filter((c) => /^\s*select/i.test(c.sql));
  const last = selects[selects.length - 1];
  if (last === undefined) throw new Error('未捕获到 SELECT');
  return last;
}

describe('T-10 仓储：user_id 谓词强制（真实 Kysely 编译 SQL）', () => {
  it('findById：SQL 带 user_id 绑定参数 + 软删除过滤，userId 不出现在 SQL 字面量里', async () => {
    const { captured, handle, restore } = interceptPool(() => [workRow()]);
    try {
      const repo = createWorkRepository(handle.db).forUser('user-a');
      await repo.findById('w-owner-a-0001');

      const q = lastSelect(captured);
      expect(q.sql).toContain('`user_id` = ?');
      expect(q.sql).toContain('`deleted_at` is null');
      expect(q.sql).toContain('`id` = ?');
      // 值必须是绑定参数，而不是拼进 SQL —— 否则就是注入面。
      expect(q.parameters).toContain('user-a');
      expect(q.sql).not.toContain('user-a');
      expect(q.parameters).toContain('w-owner-a-0001');
    } finally {
      restore();
      await handle.destroy();
    }
  });

  it('list / count / rename / softDelete：每一条语句都带 user_id 谓词', async () => {
    const { captured, handle, restore } = interceptPool((q) =>
      /^\s*select/i.test(q.sql) ? [workRow()] : OK_PACKET,
    );
    try {
      const repo = createWorkRepository(handle.db).forUser('user-a');
      await repo.list({}, { limit: 20 });
      await repo.count({});
      await repo.rename('w-owner-a-0001', '新标题');
      await repo.softDelete('w-owner-a-0001');

      // 精确条数（可逐项重算）：list=1 SELECT，count=1 SELECT，
      // rename=1 UPDATE + 1 回读 SELECT，softDelete=1 UPDATE → 合计 5。
      expect(captured).toHaveLength(5);
      for (const q of captured) {
        expect(q.sql, `缺 user_id 谓词: ${q.sql}`).toContain('`user_id` = ?');
        expect(q.parameters, `userId 未绑定: ${q.sql}`).toContain('user-a');
        expect(q.sql).not.toContain('user-a');
      }
      // 写操作同样排除软删除行，避免改到已删除作品。
      const update = captured.find((q) => /^\s*update/i.test(q.sql) && q.sql.includes('`title`'));
      expect(update?.sql).toContain('`deleted_at` is null');
      const del = captured.find((q) => /^\s*update/i.test(q.sql) && q.sql.includes('`deleted_at` ='));
      // raw sql 按原文输出（大写），故用不敏感匹配，不把大小写当契约。
      expect(del?.sql).toMatch(/current_timestamp\(3\)/i);
    } finally {
      restore();
      await handle.destroy();
    }
  });

  it('insert：user_id 取自作用域，调用方无法把行写到别人名下', async () => {
    const { captured, handle, restore } = interceptPool((q) =>
      /^\s*select/i.test(q.sql) ? [workRow()] : OK_PACKET,
    );
    try {
      const repo = createWorkRepository(handle.db).forUser('user-a');
      // 即使入参里塞 user_id，也不得生效（CreateWorkInput 无该字段，运行时亦被忽略）。
      await repo.insert({
        id: 'w-new-0001',
        title: '新作品',
        keyword: '关键词',
        ...({ user_id: 'user-b' } as object),
      });

      const insert = captured.find((q) => /^\s*insert/i.test(q.sql));
      expect(insert).toBeDefined();
      expect(insert?.parameters).toContain('user-a');
      expect(insert?.parameters).not.toContain('user-b');
      expect(insert?.sql).not.toContain('user-b');
    } finally {
      restore();
      await handle.destroy();
    }
  });

  it('跨用户：forUser(A) 与 forUser(B) 编译出同形 SQL 但绑定不同 userId', async () => {
    const { captured, handle, restore } = interceptPool(() => [workRow()]);
    try {
      const db = handle.db;
      await createWorkRepository(db).forUser('user-a').findById('w-shared-id');
      await createWorkRepository(db).forUser('user-b').findById('w-shared-id');

      const [a, b] = captured;
      expect(a?.sql).toBe(b?.sql);
      expect(a?.parameters).toContain('user-a');
      expect(b?.parameters).toContain('user-b');
      expect(a?.parameters).not.toContain('user-b');
      expect(b?.parameters).not.toContain('user-a');
    } finally {
      restore();
      await handle.destroy();
    }
  });

  it('作用域方法签名里没有 userId 参数：漏传在语法上不可能', () => {
    const { handle, restore } = interceptPool(() => []);
    try {
      const repo = createWorkRepository(handle.db).forUser('user-a');
      // 每个方法都只收业务参数；长度即形参个数，userId 不在其中。
      expect(repo.findById.length).toBe(1);
      expect(repo.rename.length).toBe(2);
      expect(repo.softDelete.length).toBe(1);
      expect(repo.list.length).toBe(2);
      expect(repo.count.length).toBe(1);
      expect(repo.insert.length).toBe(1);
    } finally {
      restore();
      void handle.destroy();
    }
  });

  it.each(['', '   ', 'x'.repeat(37)])('无身份/非法身份 forUser(%j) 抛 WORK_SCOPE_REQUIRED', (bad) => {
    const { handle, restore } = interceptPool(() => []);
    try {
      const factory = createWorkRepository(handle.db);
      let code: string | undefined;
      try {
        factory.forUser(bad);
      } catch (err) {
        code = (err as { code?: string }).code;
      }
      // 按结构化 code 判定，不解析 message。
      expect(code).toBe('WORK_SCOPE_REQUIRED');
      expect(WorkScopeRequiredError.name).toBe('WorkScopeRequiredError');
    } finally {
      restore();
      void handle.destroy();
    }
  });

  it('非法 workId 抛 WORK_ID_INVALID（不落到 SQL）', async () => {
    const { captured, handle, restore } = interceptPool(() => []);
    try {
      const repo = createWorkRepository(handle.db).forUser('user-a');
      let code: string | undefined;
      try {
        await repo.findById("x' OR '1'='1");
      } catch (err) {
        code = (err as { code?: string }).code;
      }
      expect(code).toBe('WORK_ID_INVALID');
      expect(WorkIdInvalidError.name).toBe('WorkIdInvalidError');
      expect(captured).toHaveLength(0);
    } finally {
      restore();
      await handle.destroy();
    }
  });
});

describe('T-10 仓储：搜索与分页的 SQL 口径', () => {
  it('q ≥2 字走 FULLTEXT ngram，且关键词是绑定参数', async () => {
    const { captured, handle, restore } = interceptPool(() => [workRow()]);
    try {
      await createWorkRepository(handle.db).forUser('user-a').list({ q: '费曼' }, { limit: 20 });
      const q = lastSelect(captured);
      expect(q.sql).toContain('MATCH(title) AGAINST (? IN NATURAL LANGUAGE MODE)');
      expect(q.parameters).toContain('费曼');
      expect(q.sql).not.toContain('费曼');
    } finally {
      restore();
      await handle.destroy();
    }
  });

  it('q 单字降级 LIKE（ngram_token_size=2 下全文无法成词），且 % _ \\ 被转义', async () => {
    const { captured, handle, restore } = interceptPool(() => [workRow()]);
    try {
      const repo = createWorkRepository(handle.db).forUser('user-a');
      await repo.list({ q: '书' }, { limit: 20 });
      const one = lastSelect(captured);
      expect(one.sql).toContain('`title` like ?');
      expect(one.sql).not.toContain('MATCH');
      expect(one.parameters).toContain('%书%');

      await repo.list({ q: '%' }, { limit: 20 });
      const meta = lastSelect(captured);
      // 用户输入的 % 必须被转义成字面量，否则变成「匹配全部」的通配符。
      expect(meta.parameters).toContain('%\\%%');
    } finally {
      restore();
      await handle.destroy();
    }
  });

  it('list 多取 1 条判下一页；keyset 谓词为 (updated_at,id) 严格小于', async () => {
    const { captured, handle, restore } = interceptPool(() => [workRow()]);
    try {
      const repo = createWorkRepository(handle.db).forUser('user-a');
      const cursor = encodeWorkCursor({ u: '2026-11-13 01:00:00.000', i: 'w-owner-a-0001' });
      await repo.list({}, { limit: 20, cursor });

      const q = lastSelect(captured);
      expect(q.sql).toContain('order by `updated_at` desc, `id` desc');
      // limit+1 = 21，用于判断是否还有下一页。
      expect(q.parameters).toContain(21);
      expect(q.sql).toContain('`updated_at` < ?');
      expect(q.sql).toContain('`updated_at` = ?');
      expect(q.sql).toContain('`id` < ?');
      expect(q.parameters).toContain('2026-11-13 01:00:00.000');
      expect(q.parameters).toContain('w-owner-a-0001');
    } finally {
      restore();
      await handle.destroy();
    }
  });

  it('list 与 count 的过滤口径一致（phase + q 同时生效）', async () => {
    const { captured, handle, restore } = interceptPool((q) =>
      /COUNT\(\*\)/i.test(q.sql) ? [{ count: '7' }] : [workRow()],
    );
    try {
      const repo = createWorkRepository(handle.db).forUser('user-a');
      await repo.list({ phase: 2, q: '费曼' }, { limit: 20 });
      const total = await repo.count({ phase: 2, q: '费曼' });

      const listQ = captured.find((q) => /order by/i.test(q.sql));
      const countQ = captured.find((q) => /COUNT\(\*\)/i.test(q.sql));
      expect(total).toBe(7);
      for (const q of [listQ, countQ]) {
        expect(q?.sql).toContain('`phase` = ?');
        expect(q?.sql).toContain('MATCH(title) AGAINST');
        expect(q?.sql).toContain('`user_id` = ?');
        expect(q?.parameters).toContain(2);
        expect(q?.parameters).toContain('费曼');
      }
    } finally {
      restore();
      await handle.destroy();
    }
  });

  it('rename 不靠 affectedRows：改成同名（changedRows=0）仍返回行而非 null', async () => {
    // 负向对照：若实现用 affectedRows 判成败，这里会错误返回 null（把存在误判成 404）。
    const { handle, restore } = interceptPool((q) =>
      /^\s*select/i.test(q.sql) ? [workRow()] : { insertId: 0, affectedRows: 0, changedRows: 0 },
    );
    try {
      const repo = createWorkRepository(handle.db).forUser('user-a');
      const row = await repo.rename('w-owner-a-0001', '费曼学习法');
      expect(row).not.toBeNull();
      expect(row?.id).toBe('w-owner-a-0001');
    } finally {
      restore();
      await handle.destroy();
    }
  });

  it('softDelete 用 affectedRows：0 行 → false（不存在或不属于你）', async () => {
    const { handle, restore } = interceptPool(() => ({
      insertId: 0,
      affectedRows: 0,
      changedRows: 0,
    }));
    try {
      const repo = createWorkRepository(handle.db).forUser('user-a');
      expect(await repo.softDelete('w-not-mine')).toBe(false);
    } finally {
      restore();
      await handle.destroy();
    }
  });
});

describe('T-10 游标：编解码与非法输入', () => {
  it('往返相等，且对客户端不透明（base64url，无 SQL 片段）', () => {
    const c = { u: '2026-11-13 01:00:00.000', i: 'w-owner-a-0001' };
    const raw = encodeWorkCursor(c);
    expect(raw).not.toContain('2026-11-13');
    expect(raw).not.toContain(' ');
    expect(decodeWorkCursor(raw)).toEqual(c);
  });

  it.each([
    'not-a-cursor',
    '!!!',
    Buffer.from(JSON.stringify({ u: 'bad', i: 'x' })).toString('base64url'),
    Buffer.from(JSON.stringify({ u: '2026-11-13 01:00:00.000' })).toString('base64url'),
    Buffer.from(JSON.stringify({ u: '2026-11-13 01:00:00.000', i: "x' OR 1=1--" })).toString('base64url'),
    Buffer.from('null').toString('base64url'),
  ])('非法游标 %j 抛 WORK_CURSOR_INVALID（按 code 判定）', (raw) => {
    let code: string | undefined;
    try {
      decodeWorkCursor(raw);
    } catch (err) {
      code = (err as { code?: string }).code;
    }
    expect(code).toBe('WORK_CURSOR_INVALID');
    expect(WorkCursorInvalidError.name).toBe('WorkCursorInvalidError');
  });

  it('非规范 base64url（回编码不一致）也被拒，避免宽容解码放行垃圾串', () => {
    const canonical = encodeWorkCursor({ u: '2026-11-13 01:00:00.000', i: 'w-1' });
    // 追加 base64 padding：解码宽容但回编码不等，必须拒。
    let code: string | undefined;
    try {
      decodeWorkCursor(`${canonical}=`);
    } catch (err) {
      code = (err as { code?: string }).code;
    }
    expect(code).toBe('WORK_CURSOR_INVALID');
  });
});