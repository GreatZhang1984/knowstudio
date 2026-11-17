/**
 * 基础设施 provider：DB_CLIENT / REDIS_CLIENT / OBJECT_STORAGE / AUTH_OPTIONS。
 *
 * 跨包冻结接口（别人实现，按签名 import，不自己重写）：
 *  - WP10 packages/db：createDbClient(config: DbConfig): Kysely<Database>
 *  - WP13 packages/redis：createRedisClient(config: RedisConfig): Redis
 *  - packages/storage（已落地）：createObjectStorage(config): ObjectStorage
 *
 * 为什么用「变量 specifier 的动态 import」而非静态 import：
 *  packages/db/src 与 packages/redis/src 在并行期间尚未落地（实测仅 package.json），
 *  静态 import 会让 tsc/vitest 在我方路径报「模块不存在」。变量 specifier 的动态 import
 *  在 TS 里类型为 any（不触发 TS2307），运行时才解析；provider 是惰性的，只有真正被注入
 *  时才执行。测试用 override 替换这些 provider，故不会触发缺失模块。WP10/WP13 落地后
 *  生产路径经 package.json exports 正常解析。已在报告列出「待 WP10/WP13 落地」。
 */
import type { Provider } from '@nestjs/common';
import { resolve } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { DB_CLIENT, OBJECT_STORAGE, REDIS_CLIENT } from '../shared/tokens.js';
import { AUTH_OPTIONS } from '../auth/auth.tokens.js';
import { readAuthOptions, readInfrastructureEnv, type AuthOptions } from '../config/env.js';

function envRecord(cfg: ConfigService): Record<string, string | undefined> {
  const keys = [
    'JWT_SECRET',
    'ACCESS_TOKEN_TTL_SEC',
    'REFRESH_TTL_SEC',
    'CODE_TTL_SEC',
    'CODE_RESEND_COOLDOWN_SEC',
    'COOKIE_SECURE',
    'COOKIE_DOMAIN',
    'DATABASE_URL',
    'DB_CONNECTION_LIMIT',
    'REDIS_URL',
    'REDIS_KEY_PREFIX',
    'S3_ENDPOINT',
    'S3_REGION',
    'S3_BUCKET',
    'S3_ACCESS_KEY_ID',
    'S3_SECRET_ACCESS_KEY',
    'S3_FORCE_PATH_STYLE',
  ];
  const out: Record<string, string | undefined> = {};
  for (const key of keys) out[key] = cfg.get<string>(key);
  return out;
}

export function infrastructureProviders(): Provider[] {
  return [
    {
      provide: AUTH_OPTIONS,
      useFactory: (cfg: ConfigService): AuthOptions => readAuthOptions(envRecord(cfg)),
      inject: [ConfigService],
    },
    {
      provide: DB_CLIENT,
      useFactory: async (cfg: ConfigService): Promise<unknown> => {
        const env = readInfrastructureEnv(envRecord(cfg));
        const specifier = '@knowstudio/db';
        const mod = (await import(specifier)) as {
          createDbClient(config: { url: string; connectionLimit?: number }): unknown;
        };
        return mod.createDbClient({ url: env.databaseUrl, connectionLimit: env.dbConnectionLimit });
      },
      inject: [ConfigService],
    },
    {
      provide: REDIS_CLIENT,
      useFactory: async (cfg: ConfigService): Promise<unknown> => {
        const env = readInfrastructureEnv(envRecord(cfg));
        const specifier = '@knowstudio/redis';
        const mod = (await import(specifier)) as {
          createRedisClient(config: { url: string; keyPrefix?: string }): unknown;
        };
        // 会话/验证码键已在 store 内显式命名空间（ks:），不依赖客户端 keyPrefix，
        // 避免 ioredis keyPrefix 对 EVAL 键不生效导致 GET/SET 与 EVAL 键不一致。
        return mod.createRedisClient({ url: env.redisUrl });
      },
      inject: [ConfigService],
    },
    {
      provide: OBJECT_STORAGE,
      useFactory: async (cfg: ConfigService): Promise<unknown> => {
        const env = readInfrastructureEnv(envRecord(cfg));
        const specifier = '@knowstudio/storage';
        const mod = (await import(specifier)) as {
          createObjectStorage(config: Record<string, unknown>): unknown;
          createLocalStorage(config: Record<string, unknown>): unknown;
        };
        if (env.s3AccessKeyId === '' || env.s3SecretAccessKey === '') {
          return mod.createLocalStorage({
            root: process.env['LOCAL_STORAGE_ROOT'] ?? resolve(process.cwd(), '.local-storage'),
          });
        }
        return mod.createObjectStorage({
          endpoint: env.s3Endpoint,
          region: env.s3Region,
          bucket: env.s3Bucket,
          accessKeyId: env.s3AccessKeyId,
          secretAccessKey: env.s3SecretAccessKey,
          forcePathStyle: env.s3ForcePathStyle,
        });
      },
      inject: [ConfigService],
    },
  ];
}
