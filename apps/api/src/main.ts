/**
 * NestJS 引导入口。
 *  - import 'reflect-metadata' 必须在最前（装饰器 DI 依赖）。
 *  - HTTP 端口从环境变量 PORT 读，默认 3000；测试一律 listen(0) 临时端口（见 test/）。
 *  - 全局前缀 /api（arch §10.1）。
 *
 * 生产启动依赖 WP10（packages/db）/ WP13（packages/redis）与 T-03 建表，均已落地：
 * MySQL 36 表已建、两包 src 就绪，生产引导已实测启动（GET /api/me 返回真实库用户）。
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { buildAppModule } from './app.module.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(buildAppModule());
  app.setGlobalPrefix('api');
  app.enableShutdownHooks();
  const port = Number(process.env['PORT'] ?? 3000);
  await app.listen(port);
}

void bootstrap();