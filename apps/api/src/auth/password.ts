/**
 * 密码哈希：argon2id（@node-rs/argon2，预编译、无 node-gyp）。
 *
 * 口径披露：SPEC 与 arch **未指定**哈希算法；argon2id 是协调者的工程决定，
 * 见交付报告。本文件不得自行替换为其他算法。
 * 实测：Algorithm.Argon2id === 2，hash 产出 `$argon2id$` 前缀，verify 通过。
 */
import { hash, verify, type Algorithm } from '@node-rs/argon2';

/**
 * argon2id 的枚举值（实测 Algorithm.Argon2id === 2，且为库默认算法）。
 * 用数字字面量 + type-only _cast_ 而非 `Algorithm.Argon2id`：
 * Algorithm 是 ambient const enum，isolatedModules 下取成员值会触发 TS2748；
 * type-only 引用合法，字面量 2 即 argon2id，绝不换成其他算法。
 */
const ARGON2ID = 2 as Algorithm;

/** 哈希明文密码。返回 PHC 字符串（含算法/参数/盐），直接存 app_user.password_hash VARCHAR(255)。 */
export function hashPassword(plain: string): Promise<string> {
  return hash(plain, { algorithm: ARGON2ID });
}

/**
 * 校验密码。verify 对格式非法的哈希会抛错；这里吞掉异常返回 false，
 * 避免把「哈希损坏」变成 500，也避免按 error.message 分支（工程纪律）。
 */
export async function verifyPassword(passwordHash: string, plain: string): Promise<boolean> {
  try {
    return await verify(passwordHash, plain);
  } catch {
    return false;
  }
}