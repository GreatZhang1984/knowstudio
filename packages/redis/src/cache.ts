import type { Redis } from 'ioredis';

/**
 * 架构 §9.4 缓存策略表（spark-output/architecture/knowledge-video-tool.md:1795-1802）。
 * TTS 音频不在这里：它落 asset_layer + uq_layer_reuse（MySQL），不是 Redis 缓存。
 * 选题「换一批」刻意不缓存——缓存会让它返回同一批，正是 D-09 的坑。
 */
export const CACHE_TTL = {
  searchResult: 86_400,
  embedding: 2_592_000,
  llmStructured: 21_600,
  platformRules: 600,
} as const;

export interface CacheStore {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSec: number): Promise<void>;
  del(key: string): Promise<void>;
}

export function createCacheStore(connection: Redis): CacheStore {
  return {
    async get<T>(key: string): Promise<T | null> {
      const raw = await connection.get(key);
      return raw === null ? null : (JSON.parse(raw) as T);
    },
    async set<T>(key: string, value: T, ttlSec: number): Promise<void> {
      await connection.set(key, JSON.stringify(value), 'EX', ttlSec);
    },
    async del(key: string): Promise<void> {
      await connection.del(key);
    },
  };
}