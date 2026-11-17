import type { Redis } from 'ioredis';

export interface RateLimitRule {
  readonly capacity: number;
  readonly windowSec: number;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** 供 X-RateLimit-Remaining 头（架构 §10.1）。 */
  readonly remaining: number;
  /** 供 429 RATE_LIMITED 的 details 与 Retry-After 头；放行时为 0。 */
  readonly retryAfterSec: number;
}

export interface RateLimiter {
  consume(key: string, rule: RateLimitRule): Promise<RateLimitDecision>;
  reset(key: string): Promise<void>;
}

/**
 * 架构 §9.5 限频表（spark-output/architecture/knowledge-video-tool.md:1811）。
 * 原文把这些阈值标为 [推断]，故此处照抄不自行调整；校准属产品决策。
 */
export const RATE_LIMITS = {
  discoverSearch: { capacity: 20, windowSec: 3600 },
  topicGenerate: { capacity: 12, windowSec: 3600 },
  topicRefresh: { capacity: 12, windowSec: 3600 },
  scriptGenerate: { capacity: 6, windowSec: 3600 },
  styleRewrite: { capacity: 12, windowSec: 3600 },
  titleRegenerate: { capacity: 30, windowSec: 3600 },
} as const satisfies Record<string, RateLimitRule>;

/**
 * 时钟取 Redis TIME 而非进程 Date.now()：限频是多实例共享状态，
 * 用各 API 实例的本地钟会让同一用户在两台机器上拿到两份配额。
 * 令牌与时间戳存 HASH， refill 与扣减在同一段 Lua 内完成，连点不会超发。
 */
const CONSUME_SCRIPT = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local windowUs = tonumber(ARGV[2])
local now = redis.call('TIME')
local nowUs = tonumber(now[1]) * 1000000 + tonumber(now[2])
local rate = capacity / windowUs
local state = redis.call('HMGET', key, 'tokens', 'us')
local tokens = tonumber(state[1])
local lastUs = tonumber(state[2])
if tokens == nil or lastUs == nil then
  tokens = capacity
  lastUs = nowUs
end
local elapsed = nowUs - lastUs
if elapsed < 0 then elapsed = 0 end
tokens = math.min(capacity, tokens + elapsed * rate)
local allowed = 0
local retryUs = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  retryUs = math.ceil((1 - tokens) / rate)
end
redis.call('HSET', key, 'tokens', tokens, 'us', nowUs)
redis.call('PEXPIRE', key, math.ceil(windowUs / 1000) * 2)
return { allowed, math.floor(tokens), math.ceil(retryUs / 1000000) }
`;

export function createRateLimiter(connection: Redis): RateLimiter {
  return {
    async consume(key: string, rule: RateLimitRule): Promise<RateLimitDecision> {
      const [allowed, remaining, retryAfterSec] = (await connection.eval(
        CONSUME_SCRIPT,
        1,
        key,
        rule.capacity,
        rule.windowSec * 1_000_000,
      )) as [number, number, number];
      return { allowed: allowed === 1, remaining, retryAfterSec };
    },
    async reset(key: string): Promise<void> {
      await connection.del(key);
    },
  };
}