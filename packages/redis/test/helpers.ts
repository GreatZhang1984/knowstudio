import { Redis } from 'ioredis';
import {
  createCacheStore,
  createPubSubHub,
  createRateLimiter,
  createRedisClient,
  quitAndEnd,
  type CacheStore,
  type PubSubHub,
  type RateLimiter,
} from '../src/index.js';

/** 与 infra/.env 的 REDIS_URL 一致；CI 可用环境变量覆盖。 */
export const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

/** 本包三个原语的组合形态：createRedisClient 只给连接，原语由工厂按需装配。 */
export interface RedisPrimitives {
  connection: Redis;
  cache: CacheStore;
  rateLimit: RateLimiter;
  pubsub: PubSubHub;
}

export interface RedisFixture {
  client: RedisPrimitives;
  /** 无 keyPrefix 的旁路连接：核对真实落盘键名/频道名，并负责清理。 */
  raw: Redis;
  prefix: string;
}

/**
 * 本包测试一律打真实 Redis，不用 mock 冒充。
 * 不可达时显式抛错让门禁变红——静默 skip 会把「没验证」伪装成「已通过」。
 */
export async function startRedisFixture(label: string): Promise<RedisFixture> {
  const prefix = `t04:${label}:${process.pid}:${Date.now()}:`;
  const connection = createRedisClient({ url: REDIS_URL, keyPrefix: prefix });
  const raw = new Redis(REDIS_URL);
  // 连接级 error 若无监听会直接崩进程；可达性由下面的 ping 显式断言，故此处不是静默吞错。
  connection.on('error', () => {});
  raw.on('error', () => {});

  const pong = await Promise.race([
    connection.ping(),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`真实 Redis 不可达（${REDIS_URL}），T-04 集成测试无法验证`)),
        5000,
      ),
    ),
  ]);
  if (pong !== 'PONG') throw new Error(`Redis PING 异常: ${pong}`);

  return {
    client: {
      connection,
      cache: createCacheStore(connection),
      rateLimit: createRateLimiter(connection),
      pubsub: createPubSubHub({ connection, url: REDIS_URL, keyPrefix: prefix }),
    },
    raw,
    prefix,
  };
}

export async function stopRedisFixture(f: RedisFixture): Promise<void> {
  // SCAN 的 MATCH 模式不受 ioredis keyPrefix 影响，故用旁路连接 + 完整前缀模式清理。
  let cursor = '0';
  do {
    const [next, keys] = await f.raw.scan(cursor, 'MATCH', `${f.prefix}*`, 'COUNT', 500);
    cursor = next;
    if (keys.length > 0) await f.raw.del(...keys);
  } while (cursor !== '0');
  await f.client.pubsub.close();
  await quitAndEnd(f.client.connection);
  await quitAndEnd(f.raw);
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}