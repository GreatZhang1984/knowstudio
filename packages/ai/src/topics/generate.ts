import { z } from 'zod';
import type { Material } from '@knowstudio/contracts';
import type { LlmPort } from '../ports.js';

export const GeneratedTopicSchema = z.object({
  hook: z.string().min(1),
  angle: z.string().min(1),
  blankPoint: z.string().min(1),
  basisMaterialIds: z.array(z.string().min(1)).min(1),
});
export type GeneratedTopic = z.infer<typeof GeneratedTopicSchema>;

export interface GenerateTopicsInput {
  readonly keyword: string;
  readonly materials: readonly Material[];
  readonly generationIndex: number;
}

export interface GenerateTopicsResult {
  readonly topics: readonly GeneratedTopic[];
  readonly provider: string;
  readonly model: string;
}

/**
 * T-25 选题生成端口用例。basis 在端口边界收敛到调用方传入的可见素材，
 * 防止录制/供应商结果引用当前用户看不见的素材。
 */
export async function generateTopics(
  input: GenerateTopicsInput,
  llm: LlmPort,
): Promise<GenerateTopicsResult> {
  if (input.materials.length === 0) throw new Error('TOPIC_MATERIALS_REQUIRED');
  const available = new Set(input.materials.map((m) => m.id));
  const fallback = input.materials[0]?.id;
  if (fallback === undefined) throw new Error('TOPIC_MATERIALS_REQUIRED');

  const result = await llm.generateStructured({
    task: 'topics',
    schema: z.array(GeneratedTopicSchema).min(1),
    prompt: {
      system: '生成彼此差异明显的知识类短视频选题角度，每条必须绑定输入素材。',
      user: JSON.stringify({
        keyword: input.keyword,
        generationIndex: input.generationIndex,
        materials: input.materials.map((m) => ({ id: m.id, title: m.title, summary: m.summary })),
      }),
    },
    maxTokens: 4096,
    timeoutMs: 20_000,
    cacheKey: `${input.keyword}:${input.generationIndex}`,
  });

  const topics = result.data.map((topic) => ({
    ...topic,
    basisMaterialIds: topic.basisMaterialIds.filter((id) => available.has(id)),
  }));
  return {
    topics: topics.map((topic) => ({
      ...topic,
      basisMaterialIds: topic.basisMaterialIds.length > 0 ? topic.basisMaterialIds : [fallback],
    })),
    provider: result.provider,
    model: result.model,
  };
}
