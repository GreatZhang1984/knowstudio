import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/auth/password.js';

describe('密码哈希 argon2id（协调者工程决定，SPEC/arch 未指定算法）', () => {
  it('hashPassword 产出 $argon2id$ 前缀的 PHC 串', async () => {
    const hash = await hashPassword('correct-horse-battery-staple');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    // app_user.password_hash VARCHAR(255)：PHC 串必须放得下
    expect(hash.length).toBeLessThanOrEqual(255);
  });

  it('正确密码校验通过，错误密码拒绝', async () => {
    const hash = await hashPassword('s3cret-pass');
    expect(await verifyPassword(hash, 's3cret-pass')).toBe(true);
    expect(await verifyPassword(hash, 'wrong-pass')).toBe(false);
  });

  it('同一密码两次哈希不同（随机盐）', async () => {
    const a = await hashPassword('same-pass');
    const b = await hashPassword('same-pass');
    expect(a).not.toBe(b);
    expect(await verifyPassword(a, 'same-pass')).toBe(true);
    expect(await verifyPassword(b, 'same-pass')).toBe(true);
  });

  it('损坏/非法哈希返回 false 而非抛错（避免 500，不按 message 分支）', async () => {
    expect(await verifyPassword('not-a-valid-hash', 'x')).toBe(false);
    expect(await verifyPassword('', 'x')).toBe(false);
  });
});