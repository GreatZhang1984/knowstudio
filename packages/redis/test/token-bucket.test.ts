import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RATE_LIMITS } from '../src/index.js';
import { sleep, startRedisFixture, stopRedisFixture, type RedisFixture } from './helpers.js';

describe('令牌桶限频（真实 Redis + Lua 原子）', () => {
  let f: RedisFixture;

  beforeAll(async () => {
    f = await startRedisFixture('bucket');
  });
  afterAll(async () => {
    await stopRedisFixture(f);
  });

  it('容量内放行，超出拒绝并给出 retryAfterSec', async () => {
    const rule = { capacity: 3, windowSec: 3600 };
    const first = await f.client.rateLimit.consume('u1:search', rule);
    expect(first).toEqual({ allowed: true, remaining: 2, retryAfterSec: 0 });
    expect((await f.client.rateLimit.consume('u1:search', rule)).remaining).toBe(1);
    expect((await f.client.rateLimit.consume('u1:search', rule)).remaining).toBe(0);

    const denied = await f.client.rateLimit.consume('u1:search', rule);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.retryAfterSec).toBeGreaterThan(0);
  });

  it('20/h 用尽后 retryAfterSec = 180（每 180s 补 1 个令牌）', async () => {
    const rule = RATE_LIMITS.discoverSearch;
    for (let i = 0; i < rule.capacity; i += 1) {
      expect((await f.client.rateLimit.consume('u2:search', rule)).allowed).toBe(true);
    }
    const denied = await f.client.rateLimit.consume('u2:search', rule);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSec).toBe(180);
  });

  it('20 个并发只放行 capacity 个——连点不超发', async () => {
    const rule = { capacity: 5, windowSec: 3600 };
    const results = await Promise.all(
      Array.from({ length: 20 }, () => f.client.rateLimit.consume('u3:burst', rule)),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(5);
    expect(results.filter((r) => !r.allowed)).toHaveLength(15);
    expect(results.every((r) => r.remaining >= 0)).toBe(true);
  });

  it('按窗口速率真实回填', async () => {
    const rule = { capacity: 1, windowSec: 1 };
    expect((await f.client.rateLimit.consume('u4:refill', rule)).allowed).toBe(true);
    expect((await f.client.rateLimit.consume('u4:refill', rule)).allowed).toBe(false);
    await sleep(1100);
    expect((await f.client.rateLimit.consume('u4:refill', rule)).allowed).toBe(true);
  });

  it('不同用户互不影响', async () => {
    const rule = { capacity: 1, windowSec: 3600 };
    expect((await f.client.rateLimit.consume('u5:a', rule)).allowed).toBe(true);
    expect((await f.client.rateLimit.consume('u5:b', rule)).allowed).toBe(true);
    expect((await f.client.rateLimit.consume('u5:a', rule)).allowed).toBe(false);
  });

  it('reset 后恢复满容量', async () => {
    const rule = { capacity: 2, windowSec: 3600 };
    await f.client.rateLimit.consume('u6:reset', rule);
    await f.client.rateLimit.consume('u6:reset', rule);
    expect((await f.client.rateLimit.consume('u6:reset', rule)).allowed).toBe(false);
    await f.client.rateLimit.reset('u6:reset');
    expect((await f.client.rateLimit.consume('u6:reset', rule)).remaining).toBe(1);
  });

  it('空闲桶会过期，不留永久键', async () => {
    await f.client.rateLimit.consume('u7:expire', { capacity: 2, windowSec: 1 });
    const pttl = await f.raw.pttl(`${f.prefix}u7:expire`);
    expect(pttl).toBeGreaterThan(0);
    expect(pttl).toBeLessThanOrEqual(2000);
  });

  it('RATE_LIMITS 与架构 §9.5 表一致', () => {
    expect(RATE_LIMITS.discoverSearch).toEqual({ capacity: 20, windowSec: 3600 });
    expect(RATE_LIMITS.topicGenerate).toEqual({ capacity: 12, windowSec: 3600 });
    expect(RATE_LIMITS.topicRefresh).toEqual({ capacity: 12, windowSec: 3600 });
    expect(RATE_LIMITS.scriptGenerate).toEqual({ capacity: 6, windowSec: 3600 });
    expect(RATE_LIMITS.styleRewrite).toEqual({ capacity: 12, windowSec: 3600 });
    expect(RATE_LIMITS.titleRegenerate).toEqual({ capacity: 30, windowSec: 3600 });
  });
});