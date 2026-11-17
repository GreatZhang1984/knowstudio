/**
 * discover 模块 HTTP 层共用助手（与 works.controller 同一口径，但 discover 自有，
 * 不去改动 WP11 冻结的 works.controller）。
 *
 * 刻意不 import zod：apps/api 未声明该依赖（pnpm 严格隔离下不可解析），contracts 是唯一契约源。
 * SafeParser 用结构类型兼容 zod 3/4 的 issue.path 形态。
 */
import { BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { NotFound, Unauthenticated, ValidationFailed } from '@knowstudio/contracts';
import { readPrincipal } from '../auth/auth.guard.js';
import type { AuthPrincipal } from '../shared/auth-principal.js';

/** 结构化 safeParse 适配器（不依赖 zod 类型）。 */
export interface SafeParser<T> {
  safeParse(input: unknown):
    | { success: true; data: T }
    | {
        success: false;
        error: { issues: readonly { path: readonly unknown[]; message: string }[] };
      };
}

/** 校验失败统一 400 + 契约 VALIDATION_FAILED（details.fields 逐字段定位）。 */
export function parseOr400<T>(schema: SafeParser<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw validationFailed(
      result.error.issues.map((issue) => ({
        path: issue.path.map((seg) => String(seg)).join('.'),
        message: issue.message,
      })),
    );
  }
  return result.data;
}

/** 400 + VALIDATION_FAILED，供游标非法等单字段错误复用。 */
export function validationFailed(
  fields: { path: string; message: string }[],
): BadRequestException {
  return new BadRequestException(
    ValidationFailed.parse({ code: 'VALIDATION_FAILED', message: '请求参数校验失败', details: { fields } }),
  );
}

/** 读不到主体 → 401 + 契约 Unauthenticated（含 loginUrl）。 */
export function requirePrincipal(request: Record<string, unknown>): AuthPrincipal {
  const principal = readPrincipal(request);
  if (principal === null) {
    throw new UnauthorizedException(
      Unauthenticated.parse({
        code: 'UNAUTHENTICATED',
        message: '未认证或会话已失效',
        details: { loginUrl: '/login' },
      }),
    );
  }
  return principal;
}

/**
 * 404：不存在**或不属于你**，一律同一响应体（架构 §10.1 防枚举探测）。
 * message 仅供日志/调试，前端按 code 分支，绝不解析 message。
 */
export function notFound(message = '资源不存在或不属于你'): NotFoundException {
  return new NotFoundException(NotFound.parse({ code: 'NOT_FOUND', message, details: {} }));
}

/**
 * 动态状态码响应（POST /discover/search 命中 200 / 受理 202）。
 * 用 @Res()（非 passthrough）手动 status().json()，避免 Nest 默认 POST 201 覆盖处理器设的状态。
 * 结构类型即可，不 import express（apps/api 未声明）。
 */
export interface HttpResponse {
  status(code: number): HttpResponse;
  json(body: unknown): void;
}