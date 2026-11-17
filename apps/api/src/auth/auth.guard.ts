/**
 * AuthGuard —— WP11 冻结导入路径与导出名，**不得改**。
 * 路径：apps/api/src/auth/auth.guard.ts；导出名：AuthGuard。
 *
 * 职责（arch §5.3 Guard 链第一环：AuthGuard → OwnershipGuard → GateGuard → …）：
 *  1. 从 Authorization: Bearer 取 accessToken；
 *  2. 校验 JWT 签名/过期，并确认服务端会话存在且未吊销（resolvePrincipal）；
 *  3. 通过后把 AuthPrincipal 写到 request[REQUEST_PRINCIPAL_KEY]，供 OwnershipGuard 与 handler 读取。
 *
 * 本批只做 AuthGuard。OwnershipGuard 属 WP11；GateGuard/幂等/配额拦截器是后续 Task，不提前实现。
 * 失败统一 401 + 契约 Unauthenticated 体（含 loginUrl），前端按 code 分支。
 */
import { Inject, Injectable, UnauthorizedException, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Unauthenticated } from '@knowstudio/contracts';
import { REQUEST_PRINCIPAL_KEY, type AuthPrincipal } from '../shared/auth-principal.js';
import { AuthService } from './auth.service.js';

type PrincipalRequest = {
  headers: Record<string, string | string[] | undefined>;
} & Record<string, unknown>;

function extractBearer(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match?.[1] ?? null;
}

function unauthenticated(): UnauthorizedException {
  return new UnauthorizedException(
    Unauthenticated.parse({
      code: 'UNAUTHENTICATED',
      message: '未认证或会话已失效',
      details: { loginUrl: '/login' },
    }),
  );
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<PrincipalRequest>();
    const token = extractBearer(request.headers['authorization']);
    if (token === null) {
      throw unauthenticated();
    }
    const claims = await this.auth.resolvePrincipal(token);
    if (claims === null) {
      throw unauthenticated();
    }
    const principal: AuthPrincipal = { userId: claims.sub, sessionId: claims.sid };
    request[REQUEST_PRINCIPAL_KEY] = principal;
    return true;
  }
}

/** 从 request 读取主体（OwnershipGuard / handler 复用）。未认证返回 null。 */
export function readPrincipal(request: Record<string, unknown>): AuthPrincipal | null {
  const value = request[REQUEST_PRINCIPAL_KEY];
  if (
    typeof value === 'object' &&
    value !== null &&
    'userId' in value &&
    'sessionId' in value &&
    typeof (value as AuthPrincipal).userId === 'string' &&
    typeof (value as AuthPrincipal).sessionId === 'string'
  ) {
    return value as AuthPrincipal;
  }
  return null;
}