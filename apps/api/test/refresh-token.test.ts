import { describe, expect, it } from 'vitest';
import {
  hashRefreshSecret,
  issueRefreshToken,
  newCsrfToken,
  newSessionId,
  parseRefreshToken,
} from '../src/auth/refresh-token.js';

describe('refreshToken 生成/解析/哈希', () => {
  it('issueRefreshToken 形状为 sessionId.secret，hash 是 secret 的 sha256', () => {
    const sessionId = newSessionId();
    const issued = issueRefreshToken(sessionId);
    expect(issued.token.startsWith(`${sessionId}.`)).toBe(true);
    expect(issued.hash).toBe(hashRefreshSecret(issued.secret));
    expect(issued.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('parseRefreshToken 往返一致', () => {
    const sessionId = newSessionId();
    const issued = issueRefreshToken(sessionId);
    const parts = parseRefreshToken(issued.token);
    expect(parts).not.toBeNull();
    expect(parts?.sessionId).toBe(sessionId);
    expect(parts?.secret).toBe(issued.secret);
  });

  it('非法形状返回 null（不抛错）', () => {
    expect(parseRefreshToken('')).toBeNull();
    expect(parseRefreshToken('no-dot')).toBeNull();
    expect(parseRefreshToken('.secret')).toBeNull();
    expect(parseRefreshToken('session.')).toBeNull();
  });

  it('sessionId 与 csrfToken 高熵且唯一', () => {
    const ids = new Set([newSessionId(), newSessionId(), newSessionId()]);
    expect(ids.size).toBe(3);
    const csrf = newCsrfToken();
    expect(csrf).toMatch(/^[0-9a-f]{48}$/);
    expect(newCsrfToken()).not.toBe(csrf);
  });
});