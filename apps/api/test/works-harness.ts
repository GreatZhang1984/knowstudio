/**
 * T-10 works E2E 装配：**真实 MySQL 8 + 真实 Redis 7 + 真实 Nest + listen(0) + 真实 fetch**。
 *
 * 与 WP12 的 helpers/app.ts 同一约定（本仓库未装 @nestjs/testing，故直接
 * NestFactory.create(buildAppModule(overrides, extraControllers))），额外补三件事：
 *  1. DB_CLIENT override 为 WP10 `createDb()` 的**真实 Kysely + 真实 mysql2 连接池**；
 *  2. 挂上 WORKS_CONTROLLERS / WORKS_PROVIDERS；
 *  3. 绑定 T-10 消费的两个端口（快照 / 配额）。
 *
 * ## 为什么测试用户必须是真实 app_user 行
 * `work.user_id` 有 `fk_work_user` 外键指向 `app_user(id)`。认证侧用 InMemoryUserStore
 * （不碰 DB、不改 schema），但作品落库需要真实用户行，故在**本测试 setup 内**插入两行，
 * 并在 teardown 精确删除。绝不改 fixtures/**，绝不建表 / 跑迁移（那是 WP10 边界）。
 *
 * ## 端口实现的性质（务必区分）
 * - 快照加载器：**真实读 work 行**并据实构造 WorkTruthSnapshot（无 script/asset/compliance
 *   数据时即为 null/空），闸门由 domain.deriveGates 真实派生。它不是「恒返回全 false」的假实现，
 *   因此可用于证明「闸门随真相变化」而非硬编码。完整聚合（含 script/asset/compliance）属 T-12。
 * - 配额读取器：**测试替身**。真实额度必须由 quota_ledger 聚合（T-42/T-43，packages/quota 尚未落地）。
 *   本替身只用于满足信封契约，不代表生产额度口径。已在报告「阻塞未验证」分列。
 *
 * ## 纪律
 * 不绑定 3000；不留长驻进程；teardown 关应用 + quit Redis + destroy 连接池 + 删测试数据。
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication, Provider } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Quota, WorkTruthSnapshot } from '@knowstudio/contracts';
import { createDb, type DbHandle } from '@knowstudio/db';
import type { WorkRow } from '@knowstudio/db/repositories';
import { createRedisClient } from '@knowstudio/redis';
import { buildAppModule } from '../src/app.module.js';
import { USER_STORE } from '../src/auth/auth.tokens.js';
import { InMemoryUserStore } from '../src/auth/user-store.js';
import { DB_CLIENT, REDIS_CLIENT } from '../src/shared/tokens.js';
import type { WorkQuotaReader, WorkTruthSnapshotLoader } from '../src/works/work-ports.js';
import { WORKS_CONTROLLERS, WORKS_PROVIDERS } from '../src/works/works.module.js';
import { WORK_QUOTA_READER, WORK_TRUTH_SNAPSHOT } from '../src/works/works.tokens.js';
import { makeUser } from './helpers/app.js';

const TEST_PASSWORD = 'T10-Test-Passw0rd!';

export interface TestPrincipal {
  readonly id: string;
  readonly email: string;
  readonly token: string;
}

export interface WorksTestApp {
  readonly app: INestApplication;
  readonly baseUrl: string;
  readonly handle: DbHandle;
  readonly userA: TestPrincipal;
  readonly userB: TestPrincipal;
  /** 直接经真实库插入作品（绕过 HTTP），用于构造分页/隔离的初始数据。必须 await 落库后再查询。 */
  readonly seedWork: (userId: string, title: string, updatedAt?: string) => Promise<string>;
  cleanup(): Promise<void>;
}

/** 测试替身配额：满足 QuotaSchema 恒等式 left = total - used - reserved。 */
const TEST_QUOTA: Quota = {
  total: 60,
  used: 22,
  reserved: 2,
  left: 36,
  resetAt: '2026-12-01T00:00:00.000Z',
};

/**
 * 据实构造快照：只有 work 行上的真相（selected_topic_id / script_confirmed_at / active_render_job_id），
 * 其余聚合源在本 Task 尚无数据，故为 null / 空数组。
 * 闸门交给 domain.deriveGates 判定——**此处不出现任何 gates 布尔字面量**。
 */
const snapshotLoader: WorkTruthSnapshotLoader = {
  async load(work: WorkRow): Promise<WorkTruthSnapshot> {
    return {
      workId: work.id,
      selectedTopicId: work.selected_topic_id,
      script: null,
      latestHdAsset: null,
      latestCompliance: null,
      materials: [],
      derivatives: [],
      template: null,
      bgm: null,
      lexiconVersion: 0,
    };
  },
};

const quotaReader: WorkQuotaReader = {
  async readForUser(): Promise<Quota> {
    return TEST_QUOTA;
  },
};

function shortId(prefix: string): string {
  return `${prefix}${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

export async function createWorksTestApp(): Promise<WorksTestApp> {
  process.env['JWT_SECRET'] = 'knowstudio-t10-test-jwt-secret-not-for-prod';
  process.env['COOKIE_SECURE'] = 'false';

  const handle = createDb({ connectionLimit: 4 });
  const db = handle.db;
  const redis = createRedisClient({ url: process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379' });

  const idA = shortId('t10a_');
  const idB = shortId('t10b_');
  const suffix = randomUUID().replace(/-/g, '').slice(0, 10);
  const emailA = `t10a-${suffix}@example.invalid`;
  const emailB = `t10b-${suffix}@example.invalid`;

  // 真实 app_user 行：满足 fk_work_user 外键。只插入本测试自己的两行。
  await db
    .insertInto('app_user')
    .values([
      { id: idA, name: 'T10 用户A', email: emailA },
      { id: idB, name: 'T10 用户B', email: emailB },
    ])
    .execute();

  const userStore = new InMemoryUserStore([
    await makeUser({ id: idA, email: emailA, password: TEST_PASSWORD, name: 'T10 用户A' }),
    await makeUser({ id: idB, email: emailB, password: TEST_PASSWORD, name: 'T10 用户B' }),
  ]);

  const overrides: Provider[] = [
    { provide: USER_STORE, useValue: userStore },
    { provide: REDIS_CLIENT, useValue: redis },
    { provide: DB_CLIENT, useValue: db },
    { provide: WORK_TRUTH_SNAPSHOT, useValue: snapshotLoader },
    { provide: WORK_QUOTA_READER, useValue: quotaReader },
    ...WORKS_PROVIDERS,
  ];

  const app = await NestFactory.create(buildAppModule(overrides, WORKS_CONTROLLERS), {
    logger: false,
  });
  app.setGlobalPrefix('api');
  // listen(0)：临时端口，绝不绑 3000，避免与其他并行工作包冲突。
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  async function login(email: string): Promise<string> {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account: email, credential: TEST_PASSWORD, method: 'password' }),
    });
    if (res.status !== 200) {
      throw new Error(`登录失败 status=${res.status} body=${await res.text()}`);
    }
    const body = (await res.json()) as { accessToken: string };
    return body.accessToken;
  }

  const userA: TestPrincipal = { id: idA, email: emailA, token: await login(emailA) };
  const userB: TestPrincipal = { id: idB, email: emailB, token: await login(emailB) };

  return {
    app,
    baseUrl,
    handle,
    userA,
    userB,
    async seedWork(userId: string, title: string, updatedAt?: string): Promise<string> {
      const id = shortId('w_t10_');
      // 必须 await：未落库就查询会造成偶发假绿（本轮已修掉一次 void execute() 的竞态）。
      await db
        .insertInto('work')
        .values({
          id,
          user_id: userId,
          title,
          keyword: title,
          ...(updatedAt === undefined ? {} : { updated_at: updatedAt, created_at: updatedAt }),
        })
        .execute();
      return id;
    },
    async cleanup(): Promise<void> {
      // 精确删除本测试数据：先作品后用户（外键顺序）。绝不触碰种子数据。
      await db.deleteFrom('work').where('user_id', 'in', [idA, idB]).execute();
      await db.deleteFrom('app_user').where('id', 'in', [idA, idB]).execute();
      await app.close();
      await redis.quit();
      await handle.destroy();
    },
  };
}