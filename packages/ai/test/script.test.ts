import { describe, expect, it } from 'vitest';
import { estimateDurationSec, rewritePlagiarizedLines } from '../src/script/generate.js';
import { findPlagiarism } from '../src/script/plagiarism.js';
import type { AiResult, LlmPort } from '../src/ports';

describe('T-28/T-29 文案 AI 基座', () => {
  it('时长口径统一为 round(字数 / 4.2)', () => {
    expect(estimateDurationSec('x'.repeat(210))).toBe(50);
    expect(estimateDurationSec('')).toBe(0);
  });

  it('连续命中达到 30 字时识别搬运，空白与大小写不干扰', () => {
    const source = '这是一个必须被完整复制出来才会命中的三十个字符以上的知识素材原文内容';
    const copied = `前缀 ${source} 后缀`;
    const hits = findPlagiarism([copied, '完全没有连续重合的另一句话'], [source]);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.sourceIndex).toBe(0);
    expect(hits[0]?.lineIndex).toBe(0);
    expect(hits[0]?.matchedText.length).toBeGreaterThanOrEqual(30);
    expect(findPlagiarism([copied], ['完全不同的另一个来源'])).toEqual([]);
  });

  it('搬运命中会走重述端口，并按 original 精确替换对应句子', async () => {
    const line = '这是一个必须被完整复制出来才会命中的三十个字符以上的知识素材原文内容';
    const hits = findPlagiarism([line], [line]);
    const llm: LlmPort = {
      async generateStructured<T>(): Promise<AiResult<T>> {
        return {
          data: [{ original: line, rewritten: '换一种说法保留这条知识的原意。' }] as T,
          provider: 'test',
          model: 'test',
          latencyMs: 1,
          costCny: 0,
          cacheHit: false,
        };
      },
    };
    await expect(rewritePlagiarizedLines([line], hits, llm)).resolves.toEqual([
      '换一种说法保留这条知识的原意。',
    ]);
  });
});
