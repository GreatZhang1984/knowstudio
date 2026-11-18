/**
 * @knowstudio/ai —— AI 供应商抽象与素材聚合（架构 §3.2 / §9）。
 *
 * 端口（ports）是冻结契约；sources 是 T-17 编排框架 + dev 录制适配器；
 * saturation 是 T-19 饱和度纯函数 + LLM 空白角度；llm 是 dev 录制 LLM 适配器。
 * 选题/文案/风格等任务逻辑在后续 WP 落入本包，apps/api 经高层服务调用，
 * 不直接触碰 LlmPort 的 ZodSchema（apps/api 禁 zod）。
 */
export * from './ports.js';
export * from './sources/framework.js';
export * from './sources/real.js';
export * from './sources/recorded.js';
export * from './saturation/compute.js';
export * from './saturation/blank-angles.js';
export * from './topics/generate.js';
export * from './embedding/recorded.js';
export * from './script/generate.js';
export * from './derivatives/generate.js';
export * from './script/plagiarism.js';
export * from './llm/recorded.js';
