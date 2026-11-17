/**
 * 协调者独占：鉴权主体形状。T-06 负责产出，T-10 负责消费，双方不得各自另立定义。
 * sessionId 是吊销粒度：架构 §13 要求 refresh 可吊销，会话存 Redis（客户 2026-11-13 拍板，保住 36 表）。
 */
export interface AuthPrincipal {
  readonly userId: string;
  readonly sessionId: string;
}

/** 挂在 request 上的键名，AuthGuard 写入、OwnershipGuard 与 handler 读取。 */
export const REQUEST_PRINCIPAL_KEY = 'knowstudioPrincipal';