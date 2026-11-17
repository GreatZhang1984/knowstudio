/**
 * 认证模块的 provider/controller 清单。
 * 由 app.module.ts 的 buildAppModule 组合进单一 DynamicModule，
 * 便于测试用 override 替换 USER_STORE / REDIS_CLIENT 等令牌（无需 @nestjs/testing，未安装）。
 *
 * 所有注入参数显式 @Inject(TOKEN)；class provider 的构造依赖 likewise 显式令牌。
 */
import type { Provider } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { SESSION_STORE } from '../shared/tokens.js';
import { AUTH_OPTIONS, CODE_SENDER, USER_STORE } from './auth.tokens.js';
import { AuthController } from './auth.controller.js';
import { AuthExceptionFilter } from './auth-exception.filter.js';
import { AuthGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { LocalDevCodeSender } from './code-sender.js';
import { RedisSessionStore } from './redis-session.store.js';
import { KyselyUserStore } from './user-store.js';
import { VerificationCodeStore } from './verification-code.store.js';

export const AUTH_PROVIDERS: Provider[] = [
  { provide: SESSION_STORE, useClass: RedisSessionStore },
  // 生产默认 KyselyUserStore（消费 DB_CLIENT）。T-03 已建 36 表、WP10 已落地，生产引导实测通过。
  // 测试 override 为 InMemoryUserStore。
  { provide: USER_STORE, useClass: KyselyUserStore },
  { provide: CODE_SENDER, useFactory: (): LocalDevCodeSender => new LocalDevCodeSender() },
  VerificationCodeStore,
  AuthService,
  AuthGuard,
  { provide: APP_FILTER, useClass: AuthExceptionFilter },
];

export const AUTH_CONTROLLERS = [AuthController];

// AUTH_OPTIONS 由 infrastructureProviders 提供（读 ConfigService），此处仅再导出令牌方便测试。
export { AUTH_OPTIONS };