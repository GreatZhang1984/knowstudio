/**
 * T-20/T-21 discover/library HTTP E2E 装配：**真实 MySQL 8 + 真实 Redis 7 + 真实 Nest + listen(0) + 真实 fetch**。
 *
 * 与 works-harness.ts 同一约定（本仓库未装 @nestjs/testing，直接 NestFactory.create(buildAppModule(overrides))），
 * 但刻意**只 override 三个基础设施令牌**（USER_STORE / REDIS_CLIENT / DB_CLIENT）+ OBJECT_STORAGE 桩：
 *  - WORK_TRUTH_SNAPSHOT / WORK_QUOTA_READER 用 app.module 默认纳入的 **WORKS_PORT_PROVIDERS 真实 DB 适配器**；
 *  - SOURCE_REGISTRY / LLM_PORT / 三个仓储用默认纳入的 **DISCOVER_PROVIDERS 真实生产绑定**（dev 录制 VCR）。
 * 故本 E2E 跑的是**真实生产装配**，不是测试替身拼出来的假链路（守 D-04/D-22：绝不桩闸门/配额真相端口）。
 *
 * ## 为什么主体必须是种子用户
 * dev-fixtures 的录制素材 id = seedId('mat',key)，与库内种子素材行同 id。material 仓储 findByIds 按
 * visible()（自有 OR 全局）作用域回填：只有**种子用户**才同时可见 8 条自有 + 2 条全局 = 10 条。
 * 换新建测试用户只能看到 2 条全局素材，搜索回填会塌成 2 条，无法证明真实 10 条聚合与饱和度。
 * 故主体 A = 种子用户（动态发现，不硬编码 ULID），B = 新建隔离用户（只读，用于跨用户 404 负向）。
 *
 * ## 并行污染纪律（与 work-adapters-db.test.ts / mysql-integration.test.ts 对齐）
 * mysql-integration 对 material(10)/work(3)/work_material(2) 做**全局** COUNT。故本装配：
 *  - 不新建 work / material 行（搜索与收藏都落在种子 w1 上）；
 *  - search_session **不在任何全局计数里**（只校验 keyword_hash 生成列），可安全提交，cleanup 按
 *    created_at >= 测试起点精确删除本测试新建的会话（种子 ss1 早于起点，天然不被误删）；
 *  - collect/uncollect 用例**净零**（收藏后立即取消，work_material 全局计数瞬时 +1 即恢复），
 *    cleanup 再把 w1 的引用还原到初始 {k1,h1}；
 *  - 只新建 1 行 app_user B（app_user 无全局计数），cleanup 精确删除。
 * 绝不建表 / 跑迁移 / 改种子 / 删种子用户。
 *
 * ## 纪律
 * 不绑定 3000；不留长驻进程；每个 POST search 都轮询到终态再结束用例（避免 runSearch 在 cleanup 后落库）。
 * teardown：删测试会话 + 还原 w1 收藏 + 删 B 用户 + 关应用 + quit Redis + destroy 连接池。
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication, Provider } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createDb, loadSeedData, seedId, type DbHandle } from '@knowstudio/db';
import { createRedisClient } from '@knowstudio/redis';
import { buildAppModule } from '../src/app.module.js';
import { USER_STORE } from '../src/auth/auth.tokens.js';
import { InMemoryUserStore } from '../src/auth/user-store.js';
import { DB_CLIENT, REDIS_CLIENT } from '../src/shared/tokens.js';
import { makeUser } from './helpers/app.js';

const TEST_PASSWORD = 'T36-Disc-Passw0rd!';

/** 种子素材 key（与 fixtures/seed.json 一致），用于确定性推导真实 DB 素材 id。 */
const MATERIAL_KEYS = ['k1', 'k2', 'k3', 'k4', 'h1', 'h2', 'h3', 'p1', 'p2', 'p3'] as const;
export type MaterialKey = (typeof MATERIAL_KEYS)[number];

export interface DiscoverTestApp {
  readonly app: INestApplication;
  readonly baseUrl: string;
  readonly handle: DbHandle;
  readonly db: DbHandle['db'];
  /** 主体 A = 种子用户（拥有 8 条自有素材 + 可见 2 条全局）。 */
  readonly seedUserId: string;
  readonly tokenA: string;
  /** 主体 B = 新建隔离用户（只读，无自有素材/作品）。 */
  readonly userBId: string;
  readonly tokenB: string;
  /** 搜索/收藏归属作品 = 种子 w1（费曼学习法，script 步，有选中选题与文案）。 */
  readonly workId: string;
  /** key → 真实 DB 素材 id（seedId('mat',key)，与 dev 录制 id 同源）。 */
  readonly mat: Record<MaterialKey, string>;
  /** w1 初始收藏（种子 {k1,h1}），cleanup 据此还原。 */
  readonly initialCollected: readonly string[];
  /** 种子 legacy 搜索会话 ss1（早于 24h 缓存窗口，且形状非法）。 */
  readonly legacySessionId: string;
  cleanup(): Promise<void>;
}

function shortId(prefix: string): string {
  return `${prefix}${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

/** DATETIME(3) UTC 字面量（与 seed.utcLiteral / 仓储同口径）。 */
function utcLiteral(d: Date): string {
  return d.toISOString().replace('T', ' ').replace('Z', '');
}

const compactLogger = {
  log: () => {},
  warn: () => {},
  debug: () => {},
  verbose: () => {},
  fatal: () => {},
  error: (...args: unknown[]) => {
    console.error(
      ...args.map((arg) =>
        arg instanceof Error ? `${arg.name}: ${arg.message}\n${arg.stack}` : arg,
      ),
    );
  },
};

export async function createDiscoverTestApp(): Promise<DiscoverTestApp> {
  process.env['JWT_SECRET'] = 'knowstudio-t36-disc-test-jwt-secret-not-for-prod';
  process.env['COOKIE_SECURE'] = 'false';

  const handle = createDb({ connectionLimit: 4 });
  const db = handle.db;
  const redis = createRedisClient({ url: process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379' });

  // 动态发现种子（不硬编码 ULID）：DB 未 provisioning 时大声失败，绝不静默跑空。
  const seed = loadSeedData();
  const seedUserId = seedId('u', seed.user.key);
  const workId = seedId('w', 'w1');
  const legacySessionId = seedId('ss', seed.search.key);
  const mat = Object.fromEntries(MATERIAL_KEYS.map((k) => [k, seedId('mat', k)])) as Record<
    MaterialKey,
    string
  >;

  const seedUserRow = await db
    .selectFrom('app_user')
    .select('id')
    .where('id', '=', seedUserId)
    .executeTakeFirst();
  if (seedUserRow === undefined)
    throw new Error('种子用户未落库：discover E2E 需要先 migrate + applySeed');
  const workRow = await db
    .selectFrom('work')
    .select('id')
    .where('id', '=', workId)
    .where('user_id', '=', seedUserId)
    .executeTakeFirst();
  if (workRow === undefined) throw new Error('种子作品 w1 未落库');
  const matRows = await db
    .selectFrom('material')
    .select('id')
    .where(
      'id',
      'in',
      MATERIAL_KEYS.map((k) => mat[k]),
    )
    .execute();
  if (matRows.length !== MATERIAL_KEYS.length) {
    throw new Error(`种子素材不全：期望 ${MATERIAL_KEYS.length} 条，实测 ${matRows.length} 条`);
  }

  // w1 初始收藏（种子 {k1,h1}）：cleanup 还原基准。
  const wmRows = await db
    .selectFrom('work_material')
    .select('material_id')
    .where('work_id', '=', workId)
    .where('user_id', '=', seedUserId)
    .execute();
  const initialCollected = wmRows.map((r) => r.material_id).sort();

  // 隔离用户 B：真实 app_user 行（app_user 无全局计数），只读，cleanup 精确删除。
  const userBId = shortId('t36disc_b_');
  const suffix = randomUUID().replace(/-/g, '').slice(0, 10);
  const emailB = `t36disc-b-${suffix}@example.invalid`;
  await db
    .insertInto('app_user')
    .values({ id: userBId, name: 'T36 Discover B', email: emailB })
    .execute();

  const seedEmail = seed.user.email;
  if (seedEmail === null) throw new Error('种子用户 email 为 null，无法走密码登录');
  const userStore = new InMemoryUserStore([
    await makeUser({
      id: seedUserId,
      email: seedEmail,
      password: TEST_PASSWORD,
      name: seed.user.name,
    }),
    await makeUser({ id: userBId, email: emailB, password: TEST_PASSWORD, name: 'T36 Discover B' }),
  ]);

  // 只 override 基础设施；闸门/配额/搜索端口全部走 app.module 默认的真实生产绑定。
  const overrides: Provider[] = [
    { provide: USER_STORE, useValue: userStore },
    { provide: REDIS_CLIENT, useValue: redis },
    { provide: DB_CLIENT, useValue: db },
  ];

  const app = await NestFactory.create(buildAppModule(overrides, []), {
    logger: process.env['TEST_NEST_LOG'] === 'true' ? compactLogger : false,
  });
  app.setGlobalPrefix('api');
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  // 测试起点：cleanup 据此只删本测试新建的 search_session（种子 ss1 早于起点，天然豁免）。
  const testStartLiteral = utcLiteral(new Date());

  async function login(email: string): Promise<string> {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account: email, credential: TEST_PASSWORD, method: 'password' }),
    });
    if (res.status !== 200)
      throw new Error(`登录失败 status=${res.status} body=${await res.text()}`);
    return ((await res.json()) as { accessToken: string }).accessToken;
  }

  const tokenA = await login(seedEmail);
  const tokenB = await login(emailB);

  return {
    app,
    baseUrl,
    handle,
    db,
    seedUserId,
    tokenA,
    userBId,
    tokenB,
    workId,
    mat,
    initialCollected,
    legacySessionId,
    async cleanup(): Promise<void> {
      // ① 删本测试新建的搜索会话（created_at >= 起点；种子 ss1 早于起点不被误删）。
      await db
        .deleteFrom('search_session')
        .where('user_id', '=', seedUserId)
        .where('created_at', '>=', testStartLiteral)
        .execute();
      // ② 还原 w1 收藏到初始 {k1,h1}（删掉测试期间净零用例可能残留的引用）。
      await db
        .deleteFrom('work_material')
        .where('work_id', '=', workId)
        .where('material_id', 'not in', [...initialCollected])
        .execute();
      // ③ 删隔离用户 B（B 只读，无任何子行，FK 安全）。
      await db.deleteFrom('app_user').where('id', '=', userBId).execute();
      await app.close();
      await redis.quit();
      await handle.destroy();
    },
  };
}
