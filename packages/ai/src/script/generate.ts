import { z } from 'zod';
import type { Material } from '@knowstudio/contracts';
import type { LlmPort } from '../ports.js';

export const GeneratedScriptSectionSchema = z.object({
  kind: z.enum(['hook3s', 'body', 'outro']),
  lines: z.array(z.string().min(1)).min(1),
});
export type GeneratedScriptSection = z.infer<typeof GeneratedScriptSectionSchema>;

export interface GenerateScriptInput {
  readonly keyword: string;
  readonly topicHook: string;
  readonly topicGap: string;
  readonly materials: readonly Material[];
}

export interface GenerateScriptResult {
  readonly sections: readonly GeneratedScriptSection[];
  readonly provider: string;
  readonly model: string;
}

export function estimateDurationSec(text: string): number {
  return Math.round([...text].length / 4.2);
}

export async function generateScript(
  input: GenerateScriptInput,
  llm: LlmPort,
): Promise<GenerateScriptResult> {
  const result = await llm.generateStructured({
    task: 'script',
    schema: z.array(GeneratedScriptSectionSchema).min(3),
    prompt: {
      system: '生成黄金3秒开头、知识正文、互动结尾的口播文案，语气口语化。',
      user: JSON.stringify(input),
    },
    maxTokens: 3000,
    timeoutMs: 30_000,
    cacheKey: input.keyword,
  });
  return { sections: result.data, provider: result.provider, model: result.model };
}

export const RestyleHunkSchema = z.object({
  original: z.string().min(1),
  rewritten: z.string().min(1),
});
export type RestyleHunk = z.infer<typeof RestyleHunkSchema>;

export async function generateRestyleHunks(
  input: { lines: readonly string[]; samples: readonly { title: string; content: string }[] },
  llm: LlmPort,
): Promise<readonly RestyleHunk[]> {
  const result = await llm.generateStructured({
    task: 'restyle',
    schema: z.array(RestyleHunkSchema).min(1),
    prompt: {
      system: '保留事实，只按用户风格改写语气；逐句输出 original/rewritten。',
      user: JSON.stringify(input),
    },
    maxTokens: 3000,
    timeoutMs: 25_000,
    cacheKey: '',
  });
  return result.data;
}

export async function rewritePlagiarizedLines(
  lines: readonly string[],
  hits: readonly { matchedText: string }[],
  llm: LlmPort,
): Promise<string[]> {
  if (hits.length === 0) return [...lines];
  const result = await llm.generateStructured({
    task: 'plagiarism',
    schema: z.array(RestyleHunkSchema).min(1),
    prompt: {
      system: '逐句重述，保留事实但替换连续复制表达，不得输出与原文连续30字相同。',
      user: JSON.stringify({ lines, hits }),
    },
    maxTokens: 3000,
    timeoutMs: 25_000,
    cacheKey: '',
  });
  const replacements = new Map(result.data.map((hunk) => [hunk.original, hunk.rewritten]));
  return lines.map((line) => replacements.get(line) ?? line);
}
