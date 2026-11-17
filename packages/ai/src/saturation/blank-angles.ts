/**
 * 空白角度生成（T-19 / SPEC §3.2·§6.1 / plan T-19「LLM 产 ≥2 空白角度」）。
 *
 * 空白角度 = 尚未被讲透的结合点，差异化选题机会（SPEC §13 术语表）。
 * 与饱和度 score（纯函数算）不同，空白角度由 **LLM 归纳**产出：dev 走录制 LLM（RecordedLlmAdapter），
 * staging/prod 走真实供应商，二者实现同一 LlmPort，本生成器零改动。
 *
 * 守 D-08 / AC-D2 的关键设计：
 *  - prompt 注入**真实聚合素材**（id+标题+来源+摘要），LLM 的依据只能来自这些素材；
 *  - 产出经 z.array(BlankAngleSchema).min(2) 校验（≥2，AC-D2）；
 *  - **basisMaterialIds 与真实素材 id 取交集**：剔除 LLM 幻觉/录制漂移出的悬空引用，
 *    绝不引用没被实际检索到的素材（D-08 诚实，避免「依据」造假）。
 */
import { z } from 'zod';
import { BlankAngleSchema, type BlankAngle, type Material } from '@knowstudio/contracts';
import type { AiResult, LlmPort, PromptSpec } from '../ports.js';
import { normalizeKeyword } from '../sources/recorded.js';

/** ≥2 空白角度（AC-D2 / SPEC §3.2 blankAngles ≥2）。 */
const BlankAnglesSchema = z.array(BlankAngleSchema).min(2);

export interface BlankAngleRequest {
  keyword: string;
  domain?: string;
  materials: readonly Material[];
}

/** [推断] 归纳预算：架构 §14「饱和度 ≤4s」；maxTokens 容纳 ≥2 角度 + 依据 + rationale。待 LLM WP 细化。 */
const BLANK_ANGLE_TIMEOUT_MS = 4000;
const BLANK_ANGLE_MAX_TOKENS = 1200;

function buildPrompt(req: BlankAngleRequest): PromptSpec {
  const lines = req.materials.map(
    (m) => `- [${m.id}] (${m.type}/${m.source}) ${m.title}：${m.summary}`,
  );
  return {
    system:
      '你是知识类短视频选题顾问。基于给定素材，找出 ≥2 个「尚未被讲透的结合点」（空白角度）。' +
      '每个角度 label 用「X × Y」结合式；basisMaterialIds 只能取自下方素材 id；rationale 说明为何是空白。' +
      '只输出结构化 JSON 数组，不要额外文字。',
    user:
      `关键词：${req.keyword}\n` +
      (req.domain ? `领域偏好：${req.domain}\n` : '') +
      `素材清单：\n${lines.join('\n')}`,
  };
}

/**
 * 生成空白角度。返回 AiResult 以便 API 层落 ai_call_log（provider/model/latency/cost，架构 §9.1）。
 * LLM 失败/未录制时本函数**向上抛错**，由 API 层降级为 partial（饱和度仍可算，空白角度缺失明示），不在此吞错。
 */
export async function generateBlankAngles(
  req: BlankAngleRequest,
  llm: LlmPort,
): Promise<AiResult<BlankAngle[]>> {
  const realIds = new Set(req.materials.map((m) => m.id));
  const result = await llm.generateStructured({
    task: 'blankAngles',
    schema: BlankAnglesSchema,
    prompt: buildPrompt(req),
    maxTokens: BLANK_ANGLE_MAX_TOKENS,
    timeoutMs: BLANK_ANGLE_TIMEOUT_MS,
    cacheKey: normalizeKeyword(req.keyword),
  });

  const angles = result.data.map((a) => ({
    ...a,
    basisMaterialIds: a.basisMaterialIds.filter((id) => realIds.has(id)),
  }));
  return { ...result, data: angles };
}

/** 录制种子：label + 依据素材 key（mat_<key>）+ rationale。组合根用 seed.json 的空白角度标签构建。 */
export interface BlankAngleSeed {
  label: string;
  basisKeys: readonly string[];
  rationale: string;
}

/**
 * 由种子构建一条关键词的空白角度录制payload（放进 LlmRecordingStore，键 llmRecordingKey('blankAngles', keyword)）。
 * id 用 dev 稳定 id（ba_<规范化关键词截断>_<序号>，≤36 符合 PrefixedId）；basisMaterialIds 默认映射到 mat_<key>，
 * 与 mapRecordedMaterial 缺省素材 id 同源，保证 generateBlankAngles 取交集后依据非空。
 *
 * `basisIdOf` 可选解析器：dev 组合根注入真实 DB 素材 id（seedId('mat',key)），与 RecordedMaterialSeed.id
 * 覆盖同一手法——录制素材用真实 ULID id 时，依据也必须用同一 id，否则取交集后依据被全部剔除（D-08 诚实）。
 */
export function buildBlankAngleRecording(
  keyword: string,
  seeds: readonly BlankAngleSeed[],
  basisIdOf: (key: string) => string = (k) => `mat_${k}`,
): BlankAngle[] {
  const slug = normalizeKeyword(keyword).slice(0, 24);
  return seeds.map((s, i) => ({
    id: `ba_${slug}_${i}`,
    label: s.label,
    basisMaterialIds: s.basisKeys.map(basisIdOf),
    rationale: s.rationale,
  }));
}