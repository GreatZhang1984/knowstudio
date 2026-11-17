/**
 * @knowstudio/contracts —— 唯一契约源（架构 §3.1）。
 * 前端、API、worker、E2E 共用同一份枚举与 DTO，杜绝契约漂移。
 */
export * from './enums.js';
export * from './dto.js';
export * from './script.js';
export * from './errors.js';
export * from './sse.js';
export * from './api.js';
export { buildOpenApiDocument, G5_FORBIDDEN_ROUTE_PATTERN } from './openapi.js';