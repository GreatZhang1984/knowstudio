/**
 * 把认证域结构化错误映射为契约错误体 + 正确 HTTP 状态。
 * 按异常**类型**分支（instanceof），绝不按 error.message 分支（工程纪律）。
 */
import { Catch, type ArgumentsHost, type ExceptionFilter, type HttpException } from '@nestjs/common';
import { AuthFailure, authFailureToHttp } from './auth.errors.js';
import { CodeRateLimitedError } from './verification-code.store.js';

interface JsonResponse {
  status(code: number): { json(body: unknown): void };
}

@Catch(AuthFailure, CodeRateLimitedError)
export class AuthExceptionFilter implements ExceptionFilter {
  catch(exception: AuthFailure | CodeRateLimitedError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<JsonResponse>();
    const http: HttpException =
      exception instanceof CodeRateLimitedError
        ? authFailureToHttp(new AuthFailure('RATE_LIMITED', { retryAfterSec: exception.retryAfterSec }))
        : authFailureToHttp(exception);
    response.status(http.getStatus()).json(http.getResponse());
  }
}