import { z } from 'zod';
import type { DurationVersion, PlatformId } from '@knowstudio/contracts';

export const GeneratedDerivativeSchema = z.object({
  platformId: z.enum(['douyin', 'sph', 'bili', 'xhs']),
  title: z.string().min(1).max(255),
  tags: z.array(z.string().min(1)).min(1),
  durationVersion: z.enum(['full', 'essence30', 'teaser15']),
  coverFrameTs: z.number().int().min(0),
});
export type GeneratedDerivative = z.infer<typeof GeneratedDerivativeSchema>;

export interface GenerateDerivativesInput {
  readonly keyword: string;
  readonly hook: string;
  readonly rules: readonly {
    platformId: PlatformId;
    titleMax: number;
    tagMax: number;
    maxDurationSec: number;
  }[];
}

const DURATION_BY_PLATFORM: Record<PlatformId, DurationVersion> = {
  douyin: 'essence30',
  sph: 'full',
  bili: 'full',
  xhs: 'teaser15',
};

const TAGS_BY_PLATFORM: Record<PlatformId, readonly string[]> = {
  douyin: ['学习方法', '费曼技巧', '三分钟'],
  sph: ['学习方法', '自我提升'],
  bili: ['费曼学习法', '知识科普', '深度讲解'],
  xhs: ['学习笔记', '费曼技巧', '干货'],
};

function compactTitle(keyword: string, hook: string, platformId: PlatformId): string {
  const core = hook.replace(/[。！？!?\\s]+$/u, '');
  if (platformId === 'bili') return `${keyword}：${core}`.slice(0, 80);
  if (platformId === 'xhs') return `${core}｜${keyword}`.slice(0, 30);
  return core.slice(0, 30) || keyword;
}

export function generateDerivativeMetadata(
  input: GenerateDerivativesInput,
): readonly GeneratedDerivative[] {
  if (input.rules.length === 0) throw new Error('DERIVATIVE_RULES_REQUIRED');
  return input.rules.map((rule) =>
    GeneratedDerivativeSchema.parse({
      platformId: rule.platformId,
      title: compactTitle(input.keyword || '知识方法', input.hook || '把知识讲清楚', rule.platformId),
      tags: TAGS_BY_PLATFORM[rule.platformId].slice(0, rule.tagMax),
      durationVersion: DURATION_BY_PLATFORM[rule.platformId],
      coverFrameTs: 0,
    }),
  );
}

export function regenerateDerivativeTitle(
  keyword: string,
  hook: string,
  platformId: PlatformId,
): string {
  const suffix =
    platformId === 'bili' ? '一次讲透' : platformId === 'xhs' ? '收藏版' : '别再死记硬背';
  return `${hook || keyword}｜${suffix}`.slice(0, platformId === 'bili' ? 80 : 30);
}
