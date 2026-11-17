import { describe, expect, it } from 'vitest';
import type { Material } from '@knowstudio/contracts';
import { RecordedEmbeddingAdapter, cosineSimilarity } from '../src/embedding/recorded';
import { generateTopics } from '../src/topics/generate';
import type { AiResult, LlmPort } from '../src/ports';

const material = (id: string): Material => ({
  id,
  type: 'knowledge',
  title: `素材 ${id}`,
  summary: '摘要',
  source: '测试',
  url: null,
  license: 'cleared',
  collected: true,
});

describe('T-24/T-25 选题 AI 基座', () => {
  it('生成结果只引用调用方传入的素材；录制依据不可见时回退到可见素材', async () => {
    const llm: LlmPort = {
      async generateStructured<T>(): Promise<AiResult<T>> {
        return {
          data: [
            {
              hook: '可见素材角度',
              angle: '测试',
              blankPoint: '空白',
              basisMaterialIds: ['mat_other', 'mat_ok'],
            },
          ] as T,
          provider: 'test',
          model: 'test',
          latencyMs: 1,
          costCny: 0,
          cacheHit: false,
        };
      },
    };
    const result = await generateTopics(
      { keyword: '费曼学习法', materials: [material('mat_ok')], generationIndex: 0 },
      llm,
    );
    expect(result.topics[0]?.basisMaterialIds).toEqual(['mat_ok']);
  });

  it('录制 embedding 是 1024 维；相同文本相似，不同文本不越过 0.75', async () => {
    const adapter = new RecordedEmbeddingAdapter();
    const vectors = await adapter.embed(['角度一', '角度二', '角度一']);
    for (const vector of vectors) {
      expect(vector).toHaveLength(1024);
      expect(vector.filter((value) => value !== 0)).toHaveLength(1);
    }
    expect(cosineSimilarity(vectors[0]!, vectors[2]!)).toBe(1);
    expect(cosineSimilarity(vectors[0]!, vectors[1]!)).toBeLessThanOrEqual(0.75);
  });
});
