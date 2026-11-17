/**
 * discover 模块自有注入令牌（与 works.tokens.ts 同一约定）。
 *
 * 一律 Symbol + @Inject(TOKEN)：tsx/vitest 走 esbuild，不生成 emitDecoratorMetadata，
 * 靠构造参数类型注入会「tsc 通过、运行时 undefined」。
 *
 * 跨模块复用 WORK_REPOSITORY（works.tokens）校验搜索归属的 work，不在此重复定义。
 */
export const SEARCH_SESSION_REPOSITORY = Symbol('knowstudio.discover.searchSessionRepository');
export const MATERIAL_REPOSITORY = Symbol('knowstudio.discover.materialRepository');
export const WORK_MATERIAL_REPOSITORY = Symbol('knowstudio.discover.workMaterialRepository');
export const TOPIC_REPOSITORY = Symbol('knowstudio.discover.topicRepository');
export const SCRIPT_REPOSITORY = Symbol('knowstudio.discover.scriptRepository');
export const STYLE_REPOSITORY = Symbol('knowstudio.discover.styleRepository');

/** 素材源编排注册表（架构 §9.2）。dev 绑录制适配器，staging/prod 换真实供应商，端口不变。 */
export const SOURCE_REGISTRY = Symbol('knowstudio.discover.sourceRegistry');

/** LLM 端口（架构 §9.1 / ADR-15）。dev 绑 RecordedLlmAdapter（VCR），产出空白角度。 */
export const LLM_PORT = Symbol('knowstudio.discover.llmPort');
export const EMBEDDING_PORT = Symbol('knowstudio.discover.embeddingPort');
