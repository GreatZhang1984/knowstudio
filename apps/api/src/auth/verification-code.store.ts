/**
 * 登录验证码存储（Redis）。arch §13「登录验证码限频」。
 *  - 重发冷却：codeResendCooldownSec 内不允许重发（RATE_LIMITED）。
 *  - 一次性消费：校验成功即删除；错误尝试有上限，防爆破。
 *  - 只存验证码的 sha256，不存明文。
 */
import { createHash, randomInt } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { REDIS_CLIENT } from '../shared/tokens.js';
import { AUTH_OPTIONS } from './auth.tokens.js';
import type { AuthOptions } from '../config/env.js';
import type { RedisLike } from './redis-like.js';

const CODE_PREFIX = 'ks:code:';
const COOLDOWN_PREFIX = 'ks:code:cd:';
const MAX_ATTEMPTS = 5;

export class CodeRateLimitedError extends Error {
  constructor(readonly retryAfterSec: number) {
    super('CODE_RATE_LIMITED');
  }
}

interface StoredCode {
  readonly hash: string;
  readonly attempts: number;
}

function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

@Injectable()
export class VerificationCodeStore {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: RedisLike,
    @Inject(AUTH_OPTIONS) private readonly options: AuthOptions,
  ) {}

  /** 生成并存储验证码，返回明文供 CodeSender 发送。冷却期内抛 CodeRateLimitedError。 */
  async issue(account: string): Promise<string> {
    const cooldownKey = `${COOLDOWN_PREFIX}${account}`;
    const existing = await this.redis.get(cooldownKey);
    if (existing !== null) {
      throw new CodeRateLimitedError(this.options.codeResendCooldownSec);
    }
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const stored: StoredCode = { hash: hashCode(code), attempts: 0 };
    await this.redis.set(`${CODE_PREFIX}${account}`, JSON.stringify(stored), 'EX', this.options.codeTtlSec);
    await this.redis.set(cooldownKey, '1', 'EX', this.options.codeResendCooldownSec);
    return code;
  }

  /** 校验并消费验证码。成功返回 true 并删除；失败/过期/超次返回 false。 */
  async verify(account: string, code: string): Promise<boolean> {
    const key = `${CODE_PREFIX}${account}`;
    const raw = await this.redis.get(key);
    if (raw === null) return false;
    const stored = JSON.parse(raw) as StoredCode;
    if (stored.attempts >= MAX_ATTEMPTS) {
      await this.redis.del(key);
      return false;
    }
    if (hashCode(code) !== stored.hash) {
      const next: StoredCode = { hash: stored.hash, attempts: stored.attempts + 1 };
      // 保留剩余 TTL：用 set 覆盖会重置 TTL，这里简化为重新写入并沿用 codeTtlSec 上限。
      await this.redis.set(key, JSON.stringify(next), 'EX', this.options.codeTtlSec);
      return false;
    }
    await this.redis.del(key);
    return true;
  }
}