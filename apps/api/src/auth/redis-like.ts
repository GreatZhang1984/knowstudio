/**
 * REDIS_CLIENT 的最小结构化视图。
 *
 * 为什么是结构化接口而不是 import type { Redis } from 'ioredis'：
 *  - ioredis 未在 apps/api 的依赖里（pnpm 严格隔离，实测 require.resolve 失败），
 *    且 WP13 的 packages/redis/src 尚未落地，禁止新增依赖或改别人的包。
 *  - WP13 冻结签名 createRedisClient(config): Redis（ioredis）。ioredis 的 Redis
 *    在结构上满足本接口（get/set/del/eval/quit 签名兼容），落地后由协调者复核可赋值性。
 *  - 测试用 apps/api/test/helpers 里的极简 RESP 客户端实现同一接口，直连真实 Redis 7，
 *    不依赖 ioredis，也不新增任何 npm 依赖。
 *
 * 只声明 RedisSessionStore / VerificationCodeStore 真正用到的命令子集。
 */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  /** SET key value [EX seconds]。mode 传 'EX' 时 ttl 为秒。 */
  set(key: string, value: string, mode?: 'EX' | 'PX', ttl?: number): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  /** EVAL script numkeys key... arg...。用于会话轮换的原子脚本。 */
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  quit(): Promise<unknown>;
}