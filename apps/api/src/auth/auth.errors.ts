/**
 * 认证失败 → 契约错误体映射。
 *
 * 工程纪律：**不按 error.message 分支**，用结构化 kind 字段。
 * 错误体一律复用 @knowstudio/contracts 的 zod schema（.parse 校验形状），
 * 不自发明 DTO；HTTP 状态取 contracts.ERROR_HTTP_STATUS。
 */
import { HttpException } from '@nestjs/common';
import {
  ERROR_HTTP_STATUS,
  RateLimited,
  Unauthenticated,
  ValidationFailed,
} from '@knowstudio/contracts';

export type AuthFailureKind =
  | 'INVALID_CREDENTIALS'
  | 'RATE_LIMITED'
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED';

/** 结构化认证失败。kind 是稳定判别字段，payload 携带 details 所需数据。 */
export class AuthFailure extends Error {
  constructor(
    readonly kind: AuthFailureKind,
    readonly payload: Readonly<Record<string, unknown>> = {},
  ) {
    super(kind);
  }
}

export function authFailureToHttp(failure: AuthFailure): HttpException {
  switch (failure.kind) {
    case 'RATE_LIMITED': {
      const retryAfterSec = Number(failure.payload['retryAfterSec'] ?? 60);
      const body = RateLimited.parse({
        code: 'RATE_LIMITED',
        message: '请求过于频繁，请稍后再试',
        details: { retryAfterSec },
      });
      return new HttpException(body, ERROR_HTTP_STATUS.RATE_LIMITED);
    }
    case 'VALIDATION_FAILED': {
      const fields = (failure.payload['fields'] as { path: string; message: string }[]) ?? [];
      const body = ValidationFailed.parse({
        code: 'VALIDATION_FAILED',
        message: '参数校验失败',
        details: { fields },
      });
      return new HttpException(body, ERROR_HTTP_STATUS.VALIDATION_FAILED);
    }
    case 'INVALID_CREDENTIALS':
    case 'UNAUTHENTICATED':
    default: {
      const body = Unauthenticated.parse({
        code: 'UNAUTHENTICATED',
        message: '未认证或凭证无效',
        details: { loginUrl: '/login' },
      });
      return new HttpException(body, ERROR_HTTP_STATUS.UNAUTHENTICATED);
    }
  }
}