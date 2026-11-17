/**
 * NestJS 应用装配。
 *
 * buildAppModule(overrides) 返回单一 DynamicModule，组合基础设施 + 认证 provider/controller。
 * 测试通过 overrides 替换 USER_STORE / REDIS_CLIENT 等令牌（本仓库未装 @nestjs/testing，
 * 故直接用 NestFactory.create(buildAppModule(overrides)) + listen(0) 起真实应用）。
 *
 * override 按 provide 令牌覆盖默认 provider：同令牌的默认项被过滤掉，避免重复注册。
 */
import { Module, type DynamicModule, type Provider, type Type } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AUTH_CONTROLLERS, AUTH_PROVIDERS } from './auth/auth.module.js';
import { DEV_JWT_SECRET } from './config/env.js';
import {
  COMPLIANCE_CONTROLLERS,
  COMPLIANCE_PROVIDERS,
} from './compliance/compliance.module.js';
import { DISCOVER_CONTROLLERS, DISCOVER_PROVIDERS } from './discover/discover.module.js';
import { EXPORT_CONTROLLERS, EXPORT_PROVIDERS } from './export/export.module.js';
import { infrastructureProviders } from './providers/infrastructure.providers.js';
import {
  OBSERVABILITY_CONTROLLERS,
  OBSERVABILITY_PROVIDERS,
} from './observability/observability.module.js';
import { RenderController } from './render/render.controller.js';
import { LocalStorageController } from './render/local-storage.controller.js';
import { RenderService } from './render/render.service.js';
import { WORKS_CONTROLLERS, WORKS_PORT_PROVIDERS, WORKS_PROVIDERS } from './works/works.module.js';

function providerToken(provider: Provider): unknown {
  if (typeof provider === 'object' && provider !== null && 'provide' in provider) {
    return (provider as { provide: unknown }).provide;
  }
  return provider;
}

export function buildAppModule(
  overrides: Provider[] = [],
  extraControllers: Type[] = [],
): DynamicModule {
  const base: Provider[] = [
    ...infrastructureProviders(),
    ...AUTH_PROVIDERS,
    ...WORKS_PROVIDERS,
    ...WORKS_PORT_PROVIDERS,
    ...DISCOVER_PROVIDERS,
    ...COMPLIANCE_PROVIDERS,
    ...EXPORT_PROVIDERS,
    ...OBSERVABILITY_PROVIDERS,
    RenderService,
  ];
  const overrideTokens = new Set(overrides.map(providerToken));
  const providers = base.filter((p) => !overrideTokens.has(providerToken(p))).concat(overrides);

  const secret = process.env['JWT_SECRET'] ?? DEV_JWT_SECRET;
  return {
    module: AppModule,
    imports: [
      ConfigModule.forRoot({ isGlobal: true }),
      // accessToken 15min（arch §1.2 第 18 行 / §13）。AuthService.sign 亦显式传 expiresIn。
      JwtModule.register({ secret, signOptions: { expiresIn: '15m' } }),
    ],
    // Set 去重：works-harness 经 extraControllers 再传一次 WORKS_CONTROLLERS，
    // 与默认纳入的同一控制器类引用相等，去重后只注册一次（避免 Nest 重复路由报错）。
    controllers: [
      ...new Set([
        ...AUTH_CONTROLLERS,
        ...WORKS_CONTROLLERS,
        ...DISCOVER_CONTROLLERS,
        ...COMPLIANCE_CONTROLLERS,
        ...EXPORT_CONTROLLERS,
        ...OBSERVABILITY_CONTROLLERS,
        RenderController,
        LocalStorageController,
        ...extraControllers,
      ]),
    ],
    providers,
  };
}

@Module({})
export class AppModule {}
