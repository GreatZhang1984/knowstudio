/**
 * 测试应用工厂：真实 Nest 应用 + 真实 Redis 7 + listen(0) 临时端口 + 真实 fetch。
 *  - 不绑定 3000，不留长驻进程（close 关应用 + quit Redis）。
 *  - USER_STORE override 为 InMemoryUserStore（真实 argon2id 哈希），不触碰 DB、不建表。
 *  - REDIS_CLIENT override 为 WP13 createRedisClient 返回的真实 ioredis Redis。
 *  - 本仓库未装 @nestjs/testing，故直接 NestFactory.create(buildAppModule(overrides))。
 */
import 'reflect-metadata';
import type { INestApplication, Provider, Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createRedisClient } from '@knowstudio/redis';
import { buildAppModule } from '../../src/app.module.js';
import { USER_STORE } from '../../src/auth/auth.tokens.js';
import { hashPassword } from '../../src/auth/password.js';
import { InMemoryUserStore, type UserRecord } from '../../src/auth/user-store.js';
import { DB_CLIENT, OBJECT_STORAGE, REDIS_CLIENT } from '../../src/shared/tokens.js';

export interface TestApp {
  readonly app: INestApplication;
  readonly baseUrl: string;
  readonly redis: ReturnType<typeof createRedisClient>;
  readonly userStore: InMemoryUserStore;
  close(): Promise<void>;
}

export interface MakeUserInput {
  readonly id: string;
  readonly phone?: string | null;
  readonly email?: string | null;
  readonly password?: string;
  readonly name?: string;
}

export async function makeUser(input: MakeUserInput): Promise<UserRecord> {
  const passwordHash = input.password !== undefined ? await hashPassword(input.password) : null;
  return {
    id: input.id,
    name: input.name ?? '测试用户',
    avatarUrl: null,
    phone: input.phone ?? null,
    email: input.email ?? null,
    passwordHash,
    domainPrefs: [],
    defaultPlatforms: ['douyin', 'bili'],
    planId: 'creator_168',
    theme: 'dark',
    onboardedAt: null,
    createdAt: new Date().toISOString(),
  };
}

export async function createTestApp(
  opts: { users?: UserRecord[]; extraControllers?: Type[] } = {},
): Promise<TestApp> {
  process.env['JWT_SECRET'] = 'knowstudio-test-jwt-secret-not-for-prod';
  process.env['COOKIE_SECURE'] = 'false';
  const redis = createRedisClient({ url: process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379' });
  const userStore = new InMemoryUserStore(opts.users ?? []);
  const overrides: Provider[] = [
    { provide: USER_STORE, useValue: userStore },
    { provide: REDIS_CLIENT, useValue: redis },
    // Nest 急切实例化所有单例 provider（含 useFactory）。DB_CLIENT/OBJECT_STORAGE 的工厂
    // 会动态 import 跨包入口；测试不碰 DB/对象存储，override 为桩以移除工厂、避免 boot 触发。
    { provide: DB_CLIENT, useValue: {} },
    { provide: OBJECT_STORAGE, useValue: {} },
  ];
  const app = await NestFactory.create(buildAppModule(overrides, opts.extraControllers ?? []), {
    logger: false,
  });
  app.setGlobalPrefix('api');
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    app,
    baseUrl,
    redis,
    userStore,
    async close(): Promise<void> {
      await app.close();
      await redis.quit();
    },
  };
}

/** 从 fetch 响应提取 set-cookie 键值对（简易解析，测试用）。 */
export function cookiesFrom(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = res.headers.getSetCookie?.() ?? [];
  for (const line of raw) {
    const first = line.split(';')[0] ?? '';
    const eq = first.indexOf('=');
    if (eq > 0) out[first.slice(0, eq).trim()] = first.slice(eq + 1).trim();
  }
  return out;
}

/** 把 cookie jar 拼成 Cookie 请求头。 */
export function cookieHeader(jar: Record<string, string>): string {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}