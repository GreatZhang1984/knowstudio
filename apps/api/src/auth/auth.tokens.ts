/**
 * T-06 认证模块内部注入令牌。
 *
 * 注意：DB_CLIENT / REDIS_CLIENT / OBJECT_STORAGE / SESSION_STORE 四个共享令牌
 * 由协调者冻结在 src/shared/tokens.ts，本文件**不重复定义**它们，只 import 使用。
 * 这里仅声明认证模块自有的、不属于共享冻结面的令牌。
 */
export const USER_STORE = Symbol('knowstudio.auth.userStore');
export const CODE_SENDER = Symbol('knowstudio.auth.codeSender');
export const AUTH_OPTIONS = Symbol('knowstudio.auth.options');