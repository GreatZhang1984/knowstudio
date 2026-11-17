/**
 * refreshToken 与 CSRF token 的生成/解析/哈希。
 *
 * refreshToken 形状：`${sessionId}.${secret}`。
 *  - sessionId 用于定位 Redis 会话；secret 是高熵随机串，服务端只存其 sha256。
 *  - 秘密用 sha256（非 argon2）：它是高熵随机值而非用户密码，无需抗暴力哈希，
 *    且每次请求都要比对，sha256 足够快。密码才用 argon2id（见 password.ts）。
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';

export interface RefreshTokenParts {
  readonly sessionId: string;
  readonly secret: string;
}

export interface IssuedRefreshToken {
  /** 写入 HttpOnly cookie 的完整 token。 */
  readonly token: string;
  readonly secret: string;
  /** 存入会话记录的 sha256(secret)。 */
  readonly hash: string;
}

export function hashRefreshSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export function newSessionId(): string {
  return randomUUID();
}

export function newCsrfToken(): string {
  return randomBytes(24).toString('hex');
}

export function issueRefreshToken(sessionId: string): IssuedRefreshToken {
  const secret = randomBytes(32).toString('hex');
  return { token: `${sessionId}.${secret}`, secret, hash: hashRefreshSecret(secret) };
}

/** 解析 cookie 里的 refreshToken。形状非法返回 null（不抛错，避免 500）。 */
export function parseRefreshToken(token: string): RefreshTokenParts | null {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  const sessionId = token.slice(0, dot);
  const secret = token.slice(dot + 1);
  if (sessionId.length === 0 || secret.length === 0) return null;
  return { sessionId, secret };
}