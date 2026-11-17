/**
 * 协调者独占：T-03/T-04/T-06/T-10 四个并行工作包共享的注入令牌。
 *
 * 刻意用 Symbol 显式令牌 + @Inject(TOKEN)，不依赖构造参数类型元数据：
 * tsx 与 vitest 都走 esbuild，esbuild 不实现 emitDecoratorMetadata，
 * 靠类型注入会出现「tsc 通过、运行时注入 undefined」的假绿。
 */
export const DB_CLIENT = Symbol('knowstudio.dbClient');
export const REDIS_CLIENT = Symbol('knowstudio.redisClient');
export const OBJECT_STORAGE = Symbol('knowstudio.objectStorage');
export const SESSION_STORE = Symbol('knowstudio.sessionStore');