import { describe, expect, it } from 'vitest';
import { createRedisClient } from '@knowstudio/redis';

describe('探针：WP13 createRedisClient 连通真实 Redis 7', () => {
  it('PING/SET/GET/EVAL/quit 正常', async () => {
    const redis = createRedisClient({ url: 'redis://127.0.0.1:6379' });
    try {
      const pong = await redis.ping();
      expect(pong).toBe('PONG');
      await redis.set('ks:probe:key', 'hello', 'EX', 30);
      expect(await redis.get('ks:probe:key')).toBe('hello');
      const evalResult = await redis.eval("return redis.call('GET', KEYS[1])", 1, 'ks:probe:key');
      expect(evalResult).toBe('hello');
      await redis.del('ks:probe:key');
    } finally {
      await redis.quit();
    }
  });
});