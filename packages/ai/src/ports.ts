/**
 * packages/ai 统一端口（架构 §9.1 冻结契约）。
 *
 * 为什么是端口而不是直接绑供应商 SDK：
 *  - 换供应商只改 baseURL+model（ADR-15），主备降级/熔断/计费都挂在端口边界上；
 *  - dev/CI 用录制回放（VCR，plan §6.1/§7.1），staging/prod 用真实供应商，
 *    两者实现同一端口，业务层（聚合/饱和度/选题/文案）零改动即可切换。
 *
 * 所有端口返回统一 AiResult，直接落 ai_call_log 计成本（架构 §9.1 / §7）。
 *
 * 边界（.dependency-cruiser）：本包可依赖 contracts + zod；apps/api 经高层服务调用本包，
 * 不直接触碰 LlmPort 的 ZodSchema（apps/api 禁 zod）；apps/web 永不 import 本包。
 */
import type { ZodSchema } from 'zod';
import type { Material } from '@knowstudio/contracts';

/** 统一调用结果（架构 §9.1）：provider/model/latency/cost 落 ai_call_log，cacheHit/fallback/partial 供降级与计费。 */
export interface AiResult<T> {
  data: T;
  provider: string;
  model: string;
  latencyMs: number;
  costCny: number;
  cacheHit: boolean;
  fallbackFrom?: string;
  partial?: boolean;
}

/** 素材源类别（架构 §9.1 SourceAdapter.kind）。六源归三类：知识/热点/同行。 */
export type SourceKind = 'knowledge' | 'hot' | 'peer';

/** 检索入参：关键词必填，领域偏好可选（SPEC §3.2 / SearchRequest）。 */
export interface SourceQuery {
  keyword: string;
  domain?: string;
}

/**
 * 单源部分结果（架构 §9.3 降级矩阵 / SPEC §6.1）。
 * status 语义：
 *  - ok：正常返回（data 可能为空数组，但源本身健康）；
 *  - empty：源健康但无命中（dev 录制无此关键词 / 真实源无结果）→ 前端 empty 态，非错误；
 *  - partial：超时预算内拿到一部分（单源超时即 partial，不阻塞整体）；
 *  - error：源失败（熔断/异常）→ 该列独立错误态 + partialErrors。
 * 刻意区分 empty 与 error：D-08 要求有真实空态，把「无数据」谎报成「源故障」会误导用户。
 */
export interface PartialResult<T> {
  status: 'ok' | 'empty' | 'partial' | 'error';
  data: T;
  error?: { code: string; message: string };
  latencyMs: number;
}

/** 素材源适配器（架构 §9.1）。budgetMs 是编排层切给本源的超时预算（知识8s/热点6s/同行6s，§14）。 */
export interface SourceAdapter {
  readonly id: string;
  readonly kind: SourceKind;
  search(q: SourceQuery, budgetMs: number): Promise<PartialResult<Material[]>>;
}

/**
 * LLM 提示规格。[待确认] 精确结构归 LLM 适配器 WP（T-25/T-28/T-33）细化；
 * 此处只冻结「系统提示 + 用户提示」最小形状，结构化输出由 schema 约束（ADR-15）。
 */
export interface PromptSpec {
  system?: string;
  user: string;
}

/** LLM 端口（架构 §9.1 / ADR-15）：统一 OpenAI 兼容协议，结构化输出 zod 校验。 */
export interface LlmPort {
  generateStructured<T>(req: {
    task: string;
    schema: ZodSchema<T>;
    prompt: PromptSpec;
    maxTokens: number;
    timeoutMs: number;
    cacheKey?: string;
  }): Promise<AiResult<T>>;
}

/** Embedding 端口（架构 §9.1 / ADR-09）：批量文本→向量，cosine 在应用层算（阈值 0.75）。 */
export interface EmbeddingPort {
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * TTS 音频片段。[待确认] 精确字段归 TTS WP（T-36）细化；
 * 句级时长由 ffprobe 构造（架构 §6.5），故此处不预存 durationMs，避免「假时间轴」（D-14）。
 */
export interface AudioClip {
  audio: Uint8Array;
  format: 'wav' | 'mp3';
  mimeType: string;
}

/**
 * 音色元数据（架构 §9.1：含商用授权凭证）。voice_catalog.license_evidence 非空约束（TR-2）：
 * 无凭证音色不得上架。gender 值域 [待确认] 以 voice_catalog DDL 为准（T-36）。
 */
export interface VoiceMeta {
  voiceId: string;
  name: string;
  gender: 'male' | 'female' | 'neutral';
  licenseEvidence: string;
  previewUrl?: string;
}

/** TTS 端口（架构 §9.1 / ADR-14）：分句合成 + 音色列表（含凭证）。 */
export interface TtsPort {
  synthesize(req: { text: string; voiceId: string; speed: number }): Promise<AudioClip>;
  listVoices(): Promise<VoiceMeta[]>;
}