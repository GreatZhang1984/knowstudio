/**
 * 服务端会话存储端口（arch §13：refresh 可吊销；会话存 Redis，客户 2026-11-13 拍板）。
 *
 * 硬不变量：**绝不新建数据库会话表**（全库恰好 36 表）。会话只存 Redis。
 * sessionId 是吊销粒度（shared/auth-principal.ts 注释）。
 */
export interface SessionRecord {
  readonly userId: string;
  readonly sessionId: string;
  /** 当前 refreshToken 秘密的 sha256。轮换即替换它。 */
  readonly currentRefreshHash: string;
  /** 已轮换掉的旧哈希（有界环），用于重放检测：命中即吊销整个会话。 */
  readonly previousRefreshHashes: readonly string[];
  /** double-submit CSRF token（arch §13：refresh 端点加 double-submit）。 */
  readonly csrfToken: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly revoked: boolean;
}

export interface CreateSessionInput {
  readonly userId: string;
  readonly sessionId: string;
  readonly refreshHash: string;
  readonly csrfToken: string;
  readonly ttlSec: number;
}

export type RotateFailure = 'NO_SESSION' | 'REVOKED' | 'REPLAY' | 'INVALID';

export type RotateResult =
  | { readonly ok: true; readonly userId: string; readonly sessionId: string }
  | { readonly ok: false; readonly reason: RotateFailure };

export interface SessionStore {
  create(input: CreateSessionInput): Promise<void>;
  find(sessionId: string): Promise<SessionRecord | null>;
  /** 吊销会话。返回是否确实存在并吊销了会话（不存在返回 false）。 */
  revoke(sessionId: string): Promise<boolean>;
  /**
   * 原子轮换：presentedHash 必须等于 currentRefreshHash 才放行；
   * 命中 previousRefreshHashes 判定为重放并吊销；其余拒绝。
   */
  rotate(
    sessionId: string,
    presentedHash: string,
    newHash: string,
    newCsrfToken: string,
    ttlSec: number,
  ): Promise<RotateResult>;
}