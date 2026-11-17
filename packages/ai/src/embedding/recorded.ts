import type { EmbeddingPort } from '../ports.js';

const DIMENSIONS = 1024;

function bucketOf(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % DIMENSIONS;
}

/**
 * dev/CI 录制 embedding：由 hook 生成 1024 维确定稀疏向量。
 * 相同 hook 相似度为 1，不同 hook 尽量正交，供应用层真实 cosine 与 DB CHECK 演练。
 */
export class RecordedEmbeddingAdapter implements EmbeddingPort {
  async embed(texts: readonly string[]): Promise<number[][]> {
    const used = new Set<number>();
    const textBuckets = new Map<string, number>();
    return texts.map((text) => {
      const existing = textBuckets.get(text);
      if (existing !== undefined) {
        const duplicate = new Array<number>(DIMENSIONS).fill(0);
        duplicate[existing] = 1;
        return duplicate;
      }
      let bucket = bucketOf(text);
      while (used.has(bucket)) bucket = (bucket + 1) % DIMENSIONS;
      used.add(bucket);
      textBuckets.set(text, bucket);
      const vector = new Array<number>(DIMENSIONS).fill(0);
      vector[bucket] = 1;
      return vector;
    });
  }
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) throw new Error('EMBEDDING_DIMENSION_MISMATCH');
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / Math.sqrt(normA * normB);
}
