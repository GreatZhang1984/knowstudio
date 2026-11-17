/**
 * RedisSessionStore 对**真实 Redis 7** 的单元级证明（DoD #1 的存储层基础）。
 * 用 WP13 createRedisClient 的真实 ioredis 实例；每个用例独立 sessionId，测后 del 清理。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRedisClient } from '@knowstudio/redis';
import { RedisSessionStore } from '../src/auth/redis-session.store.js';
import type { RedisLike } from '../src/auth/redis-like.js';
import { hashRefreshSecret, issueRefreshToken, newCsrfToken, newSessionId } from '../src/auth/refresh-token.js';

const redis = createRedisClient({ url: process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379' });
// ioredis Redis 在运行时满足 RedisLike（get/set/del/eval/quit，已由本套件实证），
// 但其 set 的重载签名（需 6+ 参数）无法结构赋值到窄接口；生产经 unknown 令牌注入无此检查，
// 测试在注入边界用同样的 unknown 桥接，语义一致。
const store = new RedisSessionStore(redis as unknown as RedisLike);
const TTL = 600;

beforeAll(async () => {
  await redis.ping();
});
afterAll(async () => {
  await redis.quit();
});

async function seedSession() {
  const sessionId = newSessionId();
  const refresh = issueRefreshToken(sessionId);
  const csrfToken = newCsrfToken();
  await store.create({ userId: 'u_test', sessionId, refreshHash: refresh.hash, csrfToken, ttlSec: TTL });
  return { sessionId, refresh, csrfToken };
}

describe('RedisSessionStore · 真实 Redis', () => {
  it('create + find 往返一致', async () => {
    const { sessionId, refresh, csrfToken } = await seedSession();
    try {
      const found = await store.find(sessionId);
      expect(found).not.toBeNull();
      expect(found?.userId).toBe('u_test');
      expect(found?.currentRefreshHash).toBe(refresh.hash);
      expect(found?.csrfToken).toBe(csrfToken);
      expect(found?.revoked).toBe(false);
    } finally {
      await redis.del(`ks:session:${sessionId}`);
    }
  });

  it('find 不存在的会话返回 null', async () => {
    expect(await store.find(newSessionId())).toBeNull();
  });

  it('revoke 后会话标记 revoked；重复 revoke 幂等；不存在返回 false', async () => {
    const { sessionId } = await seedSession();
    try {
      expect(await store.revoke(sessionId)).toBe(true);
      const found = await store.find(sessionId);
      expect(found?.revoked).toBe(true);
      expect(await store.revoke(sessionId)).toBe(true);
      expect(await store.revoke(newSessionId())).toBe(false);
    } finally {
      await redis.del(`ks:session:${sessionId}`);
    }
  });

  it('合法轮换：放行 + 旧哈希入环 + 新哈希生效', async () => {
    const { sessionId, refresh } = await seedSession();
    try {
      const next = issueRefreshToken(sessionId);
      const result = await store.rotate(sessionId, refresh.hash, next.hash, newCsrfToken(), TTL);
      expect(result.ok).toBe(true);
      const found = await store.find(sessionId);
      expect(found?.currentRefreshHash).toBe(next.hash);
      expect(found?.previousRefreshHashes).toContain(refresh.hash);
    } finally {
      await redis.del(`ks:session:${sessionId}`);
    }
  });

  it('重放检测：用已轮换掉的旧哈希 → REPLAY 且会话被吊销', async () => {
    const { sessionId, refresh } = await seedSession();
    try {
      const second = issueRefreshToken(sessionId);
      const ok = await store.rotate(sessionId, refresh.hash, second.hash, newCsrfToken(), TTL);
      expect(ok.ok).toBe(true);
      // 重放第一代的旧哈希
      const replay = await store.rotate(sessionId, refresh.hash, issueRefreshToken(sessionId).hash, newCsrfToken(), TTL);
      expect(replay.ok).toBe(false);
      if (!replay.ok) expect(replay.reason).toBe('REPLAY');
      const found = await store.find(sessionId);
      expect(found?.revoked).toBe(true);
    } finally {
      await redis.del(`ks:session:${sessionId}`);
    }
  });

  it('错误哈希 → INVALID；已吊销 → REVOKED；不存在 → NO_SESSION', async () => {
    const { sessionId } = await seedSession();
    try {
      const invalid = await store.rotate(sessionId, hashRefreshSecret('bogus'), issueRefreshToken(sessionId).hash, newCsrfToken(), TTL);
      expect(invalid.ok).toBe(false);
      if (!invalid.ok) expect(invalid.reason).toBe('INVALID');

      await store.revoke(sessionId);
      const revoked = await store.rotate(sessionId, hashRefreshSecret('bogus'), issueRefreshToken(sessionId).hash, newCsrfToken(), TTL);
      expect(revoked.ok).toBe(false);
      if (!revoked.ok) expect(revoked.reason).toBe('REVOKED');

      const missing = await store.rotate(newSessionId(), 'h', 'h2', 'c', TTL);
      expect(missing.ok).toBe(false);
      if (!missing.ok) expect(missing.reason).toBe('NO_SESSION');
    } finally {
      await redis.del(`ks:session:${sessionId}`);
    }
  });
});