import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CACHE_TTL } from '../src/index.js';
import { sleep, startRedisFixture, stopRedisFixture, type RedisFixture } from './helpers.js';

describe('Redis JSON 缓存（真实实例）', () => {
  let f: RedisFixture;

  beforeAll(async () => {
    f = await startRedisFixture('cache');
  });
  afterAll(async () => {
    await stopRedisFixture(f);
  });

  it('对象往返保真', async () => {
    const value = { searchId: 's1', items: [{ title: '素材' }], cacheHit: false };
    await f.client.cache.set('search:k1', value, 60);
    expect(await f.client.cache.get('search:k1')).toEqual(value);
  });

  it('未命中返回 null，而不是抛错或 undefined', async () => {
    expect(await f.client.cache.get('absent')).toBeNull();
  });

  it('TTL 真实落到 Redis（旁路连接查 TTL）', async () => {
    await f.client.cache.set('ttl-key', 1, 120);
    const ttl = await f.raw.ttl(`${f.prefix}ttl-key`);
    expect(ttl).toBeGreaterThan(110);
    expect(ttl).toBeLessThanOrEqual(120);
  });

  it('到期后真的读不到', async () => {
    await f.client.cache.set('short', 'v', 1);
    expect(await f.client.cache.get('short')).toBe('v');
    await sleep(1100);
    expect(await f.client.cache.get('short')).toBeNull();
  });

  it('del 立即失效', async () => {
    await f.client.cache.set('gone', 'v', 60);
    await f.client.cache.del('gone');
    expect(await f.client.cache.get('gone')).toBeNull();
  });

  it('覆盖写重置 TTL', async () => {
    await f.client.cache.set('overwrite', 'a', 60);
    await f.client.cache.set('overwrite', 'b', 300);
    expect(await f.client.cache.get('overwrite')).toBe('b');
    expect(await f.raw.ttl(`${f.prefix}overwrite`)).toBeGreaterThan(290);
  });

  it('CACHE_TTL 与架构 §9.4 表一致', () => {
    expect(CACHE_TTL.searchResult).toBe(86_400);
    expect(CACHE_TTL.embedding).toBe(2_592_000);
    expect(CACHE_TTL.llmStructured).toBe(21_600);
    expect(CACHE_TTL.platformRules).toBe(600);
  });
});