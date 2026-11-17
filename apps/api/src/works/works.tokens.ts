/**
 * T-10 works 模块自有注入令牌。
 *
 * 协调者冻结的四个共享令牌（DB_CLIENT / REDIS_CLIENT / OBJECT_STORAGE / SESSION_STORE）
 * 在 `../shared/tokens.ts`，本文件**不重复定义**它们，只 import 使用。
 * 这里只声明 works 模块自有、不属于共享冻结面的令牌（与 WP12 的 auth.tokens.ts 同一约定）。
 *
 * 一律 Symbol + @Inject(TOKEN)：tsx/vitest 走 esbuild，不生成 emitDecoratorMetadata，
 * 靠构造参数类型注入会「tsc 通过、运行时 undefined」。
 */
export const WORK_REPOSITORY = Symbol('knowstudio.works.repository');

/**
 * 闸门真相快照加载器（架构 §5.3「读 WorkTruthSnapshot 单次聚合查询」）。
 * 实现属后续 Task（GateGuard / T-12）：需聚合 script / video_asset / compliance_report。
 * T-10 只消费该端口，**绝不自己硬编码闸门布尔值**（D-04 根因）。
 */
export const WORK_TRUTH_SNAPSHOT = Symbol('knowstudio.works.truthSnapshot');

/**
 * 配额读取器（架构 §7.1：数字由 quota_ledger 聚合，唯一真相）。
 * 实现属 T-42/T-43（packages/quota）。T-10 只消费端口，不自行算额度，
 * 避免 D-22「三处额度各算各的」。
 */
export const WORK_QUOTA_READER = Symbol('knowstudio.works.quotaReader');

/**
 * OwnershipGuard 校验通过后把 work 行挂到 request 上，供 handler 复用，
 * 避免「Guard 查一次、handler 再查一次」的重复点查与 TOCTOU 窗口。
 * 键名自有，不与冻结的 REQUEST_PRINCIPAL_KEY 冲突。
 */
export const REQUEST_WORK_KEY = 'knowstudioWork';