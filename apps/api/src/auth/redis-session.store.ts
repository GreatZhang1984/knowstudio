/**
 * RedisSessionStore：会话存 Redis（客户 2026-11-13 拍板，保住 36 表硬不变量）。
 * 基于 REDIS_CLIENT（WP13 冻结签名 createRedisClient → ioredis Redis，结构满足 RedisLike）。
 *
 * 轮换与重放检测用单条 Lua 脚本原子完成，避免 GET/SET 之间的竞态：
 *  - presentedHash === currentRefreshHash → 放行，旧哈希入有界环，写新哈希；
 *  - presentedHash 命中 previousRefreshHashes → 重放，立即吊销整个会话；
 *  - 会话不存在 / 已吊销 / 哈希不匹配 → 拒绝。
 */
import { Inject, Injectable } from '@nestjs/common';
import { REDIS_CLIENT } from '../shared/tokens.js';
import type { RedisLike } from './redis-like.js';
import type {
  CreateSessionInput,
  RotateResult,
  SessionRecord,
  SessionStore,
} from './session-store.js';

const KEY_PREFIX = 'ks:session:';
/** 旧刷新哈希环上限：足够覆盖正常轮换窗口，又不至于无限增长。 */
const PREVIOUS_HASH_LIMIT = 5;

const ROTATE_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return '{"ok":false,"reason":"NO_SESSION"}' end
local s = cjson.decode(raw)
if s.revoked then return '{"ok":false,"reason":"REVOKED"}' end
local presented = ARGV[1]
local newHash = ARGV[2]
local newCsrf = ARGV[3]
local ttl = tonumber(ARGV[4])
if s.currentRefreshHash == presented then
  local prev = s.previousRefreshHashes or {}
  table.insert(prev, s.currentRefreshHash)
  while #prev > ${PREVIOUS_HASH_LIMIT} do table.remove(prev, 1) end
  s.previousRefreshHashes = prev
  s.currentRefreshHash = newHash
  s.csrfToken = newCsrf
  redis.call('SET', KEYS[1], cjson.encode(s), 'EX', ttl)
  return cjson.encode({ok=true, userId=s.userId, sessionId=s.sessionId})
end
for _, h in ipairs(s.previousRefreshHashes or {}) do
  if h == presented then
    s.revoked = true
    redis.call('SET', KEYS[1], cjson.encode(s), 'EX', ttl)
    return '{"ok":false,"reason":"REPLAY"}'
  end
end
return '{"ok":false,"reason":"INVALID"}'
`;

const REVOKE_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local s = cjson.decode(raw)
if s.revoked then return 1 end
s.revoked = true
local ttl = redis.call('TTL', KEYS[1])
if ttl > 0 then
  redis.call('SET', KEYS[1], cjson.encode(s), 'EX', ttl)
else
  redis.call('SET', KEYS[1], cjson.encode(s))
end
return 1
`;

function sessionKey(sessionId: string): string {
  return `${KEY_PREFIX}${sessionId}`;
}

@Injectable()
export class RedisSessionStore implements SessionStore {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: RedisLike) {}

  async create(input: CreateSessionInput): Promise<void> {
    const now = Date.now();
    const record: SessionRecord = {
      userId: input.userId,
      sessionId: input.sessionId,
      currentRefreshHash: input.refreshHash,
      previousRefreshHashes: [],
      csrfToken: input.csrfToken,
      createdAt: now,
      expiresAt: now + input.ttlSec * 1000,
      revoked: false,
    };
    await this.redis.set(sessionKey(input.sessionId), JSON.stringify(record), 'EX', input.ttlSec);
  }

  async find(sessionId: string): Promise<SessionRecord | null> {
    const raw = await this.redis.get(sessionKey(sessionId));
    if (raw === null) return null;
    return JSON.parse(raw) as SessionRecord;
  }

  async revoke(sessionId: string): Promise<boolean> {
    const result = await this.redis.eval(REVOKE_SCRIPT, 1, sessionKey(sessionId));
    return Number(result) === 1;
  }

  async rotate(
    sessionId: string,
    presentedHash: string,
    newHash: string,
    newCsrfToken: string,
    ttlSec: number,
  ): Promise<RotateResult> {
    const raw = await this.redis.eval(
      ROTATE_SCRIPT,
      1,
      sessionKey(sessionId),
      presentedHash,
      newHash,
      newCsrfToken,
      ttlSec,
    );
    return JSON.parse(String(raw)) as RotateResult;
  }
}