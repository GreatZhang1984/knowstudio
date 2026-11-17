import { Redis } from 'ioredis';

/** 跨包冻结签名（协调者 2026-11-13 下发）：WP12 按此形状 import，不得增删必填字段。 */
export interface RedisClientConfig {
  readonly url: string;
  readonly keyPrefix?: string;
}

/**
 * 返回 ioredis Redis 实例本身，不是包装对象。
 * WP12 的 REDIS_CLIENT provider 把返回值直接当 RedisLike(get/set/del/eval/quit) 注入会话存储
 * （apps/api/src/providers/infrastructure.providers.ts:6,76），包装对象会让它运行时取不到 get。
 * 缓存/令牌桶/PubSub 由本包另行导出的工厂按需组合，不塞进返回值。
 *
 * keyPrefix 交给 ioredis：已对真实 Redis 7.4 取证，它对普通键命令与 EVAL 的 KEYS 都生效。
 * 但**对 PubSub 频道不生效**，故频道前缀由 createPubSubHub 自己拼。
 */
export function createRedisClient(config: RedisClientConfig): Redis {
  return new Redis(config.url, { keyPrefix: config.keyPrefix ?? '' });
}