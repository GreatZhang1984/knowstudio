import { afterAll, describe, expect, it } from 'vitest';
import { createDbClient } from '@knowstudio/db';
import { MeResponse } from '@knowstudio/contracts';
import { KyselyUserStore, type DbLike } from '../src/auth/user-store.js';

/**
 * 真实 DB 回归：KyselyUserStore 读 app_user → MeResponse.parse（/api/me 的生产路径）。
 *
 * 堵住的缺口：T-06 单测一律用 InMemoryUserStore override，真实 createDb(dateStrings:true)
 * 路径从未被集成测试覆盖，导致 created_at 的 MySQL 空格串 'YYYY-MM-DD HH:MM:SS.mmm'
 * 未归一化成契约 UtcTimestamp=z.string().datetime() 要求的 ISO 8601，/api/me 生产 500
 * （协调者真实联调抓到，Nest 日志器 inspect 崩溃还掩盖了原始 ZodError）。
 *
 * 只读种子用户、动态发现 id/email，不写库、不污染共享数据、不依赖具体种子值。
 */
const url =
  process.env['DATABASE_URL'] ?? 'mysql://knowstudio:knowstudio_app_dev_only@127.0.0.1:3306/knowstudio';
const db = createDbClient({ url });
const store = new KyselyUserStore(db as unknown as DbLike);

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function meInput(user: NonNullable<Awaited<ReturnType<typeof store.findById>>>) {
  return {
    id: user.id,
    name: user.name,
    avatarUrl: user.avatarUrl,
    domainPrefs: [...user.domainPrefs],
    defaultPlatforms: [...user.defaultPlatforms],
    planId: user.planId,
    theme: user.theme,
    onboardedAt: user.onboardedAt,
    createdAt: user.createdAt,
  };
}

afterAll(async () => {
  await db.destroy();
});

describe('KyselyUserStore 真实 DB → MeResponse（dateStrings ISO 归一化回归）', () => {
  it('findById：createdAt 是 ISO 8601 UTC，且 MeResponse.parse 通过', async () => {
    const seed = await db.selectFrom('app_user').select('id').executeTakeFirst();
    expect(seed).toBeDefined();
    const user = await store.findById(seed!.id);
    expect(user).not.toBeNull();
    expect(user!.createdAt).toMatch(ISO_UTC);
    const me = MeResponse.parse(meInput(user!));
    expect(me.id).toBe(seed!.id);
    expect(me.createdAt).toBe(user!.createdAt);
  });

  it('findByAccount(email)：命中同一用户，createdAt 同样归一化，MeResponse.parse 通过', async () => {
    const seed = await db
      .selectFrom('app_user')
      .select(['id', 'email'])
      .where('email', 'is not', null)
      .executeTakeFirst();
    expect(seed).toBeDefined();
    const user = await store.findByAccount(seed!.email!);
    expect(user).not.toBeNull();
    expect(user!.id).toBe(seed!.id);
    expect(user!.createdAt).toMatch(ISO_UTC);
    expect(() => MeResponse.parse(meInput(user!))).not.toThrow();
  });
});