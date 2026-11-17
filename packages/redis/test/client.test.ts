import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRedisClient, quitAndEnd } from '../src/index.js';
import { REDIS_URL, startRedisFixture, stopRedisFixture, type RedisFixture } from './helpers.js';

describe('createRedisClient（跨包冻结签名）', () => {
  let f: RedisFixture;

  beforeAll(async () => {
    f = await startRedisFixture('client');
  });
  afterAll(async () => {
    await stopRedisFixture(f);
  });

  it('只传 url 即可构造，返回 ioredis Redis 实例本身', async () => {
    const bare = createRedisClient({ url: REDIS_URL });
    try {
      expect(await bare.ping()).toBe('PONG');
      expect(bare.options.keyPrefix).toBe('');
    } finally {
      await quitAndEnd(bare);
    }
  });

  it('返回值满足 WP12 RedisLike 的五个命令与调用形状（运行时可赋值性）', async () => {
    const redis = f.client.connection;
    expect(await redis.set('like', 'v', 'EX', 60)).toBe('OK');
    expect(await redis.get('like')).toBe('v');
    expect(await redis.eval("return redis.call('GET', KEYS[1])", 1, 'like')).toBe('v');
    expect(await redis.del('like')).toBe(1);
    expect(typeof redis.quit).toBe('function');
  });

  it('键命令落盘时带 keyPrefix，裸键不存在', async () => {
    await f.client.cache.set('isolated', { ok: true }, 60);
    expect(await f.raw.get(`${f.prefix}isolated`)).toBe(JSON.stringify({ ok: true }));
    expect(await f.raw.get('isolated')).toBeNull();
  });

  it('EVAL 的 KEYS 同样带前缀——GET/SET 与 Lua 写的是同一个键', async () => {
    await f.client.rateLimit.consume('bucket', { capacity: 5, windowSec: 3600 });
    const keys = await f.raw.keys(`${f.prefix}*`);
    expect(keys).toContain(`${f.prefix}bucket`);
    expect(await f.raw.exists('bucket')).toBe(0);
    // 直接用 EVAL 读回令牌桶状态，证明前缀一致而非各写各的
    const tokens = await f.client.connection.eval(
      "return redis.call('HGET', KEYS[1], 'tokens')",
      1,
      'bucket',
    );
    expect(Number(tokens)).toBe(4);
  });

  it('PubSub 频道带前缀——ioredis keyPrefix 不覆盖频道，必须自己拼', async () => {
    const unsubscribe = await f.client.pubsub.subscribe('events', () => {});
    try {
      const channels = await f.raw.pubsub('CHANNELS');
      expect(channels).toContain(`${f.prefix}events`);
      expect(channels).not.toContain('events');
    } finally {
      await unsubscribe();
    }
  });

  it('quitAndEnd 等到连接真正 end（裸 quit() 会在 ready 时就 resolve）', async () => {
    const tmp = createRedisClient({ url: REDIS_URL, keyPrefix: 't04:close:' });
    await tmp.ping();
    await quitAndEnd(tmp);
    expect(tmp.status).toBe('end');
  });

  it('quitAndEnd 对已关闭连接幂等，不抛错', async () => {
    const tmp = createRedisClient({ url: REDIS_URL });
    await tmp.ping();
    await quitAndEnd(tmp);
    await expect(quitAndEnd(tmp)).resolves.toBeUndefined();
  });

  it('按包名动态 import 可消费——WP12 provider 正是这条路径', async () => {
    const specifier = '@knowstudio/redis';
    const mod = (await import(specifier)) as {
      createRedisClient(config: { url: string; keyPrefix?: string }): unknown;
    };
    expect(typeof mod.createRedisClient).toBe('function');
    const redis = mod.createRedisClient({ url: REDIS_URL }) as {
      get(key: string): Promise<string | null>;
      set(key: string, value: string, mode?: 'EX' | 'PX', ttl?: number): Promise<unknown>;
      del(...keys: string[]): Promise<number>;
      eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
      quit(): Promise<unknown>;
    };
    try {
      await redis.set('t04:spec-probe', 'ok', 'EX', 30);
      expect(await redis.get('t04:spec-probe')).toBe('ok');
      expect(await redis.del('t04:spec-probe')).toBe(1);
    } finally {
      await redis.quit();
    }
  });
});