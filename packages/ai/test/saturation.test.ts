import { describe, expect, it } from 'vitest';
import type { Material, MaterialType } from '@knowstudio/contracts';
import {
  SATURATION_TUNING,
  computeSaturation,
  coveredPlatformsOf,
  saturationLevel,
} from '../src/saturation/compute.js';

let seq = 0;
function material(type: MaterialType, source: string): Material {
  seq += 1;
  return {
    id: `mat_t${seq}`,
    type,
    title: `${source}-${type}`,
    summary: '',
    source,
    url: null,
    license: 'unknown',
    collected: false,
  };
}

/** 与 seed.json 同形的 10 条聚合素材（4 知识 / 3 热点 / 3 同行）。 */
function seedLike(): Material[] {
  return [
    material('knowledge', '知乎'),
    material('knowledge', '公众号'),
    material('knowledge', '书籍《认知天性》'),
    material('knowledge', '知乎'),
    material('hot', '抖音'),
    material('hot', 'B站'),
    material('hot', '微博'),
    material('peer', '抖音'),
    material('peer', 'B站'),
    material('peer', '小红书'),
  ];
}

describe('saturationLevel：SPEC §3.2 分档边界', () => {
  it('0–40 蓝海 / 41–70 有空间 / 71–100 讲的人很多', () => {
    expect(saturationLevel(0)).toBe('blue_ocean');
    expect(saturationLevel(40)).toBe('blue_ocean');
    expect(saturationLevel(41)).toBe('has_room');
    expect(saturationLevel(70)).toBe('has_room');
    expect(saturationLevel(71)).toBe('saturated');
    expect(saturationLevel(100)).toBe('saturated');
  });
});

describe('computeSaturation：输入驱动（D-08，绝不恒 72）', () => {
  it('空聚合 → score 0 / confidence 0 / sufficient false（诚实空态，非默认结论）', () => {
    const s = computeSaturation([]);
    expect(s).toEqual({
      score: 0,
      level: 'blue_ocean',
      confidence: 0,
      sampleSize: 0,
      coveredPlatforms: [],
      sources: [],
      sufficient: false,
    });
  });

  it('种子 10 条 → 由素材算出 score（[推断]曲线 weighted=19 → 61），不是常量 72', () => {
    const s = computeSaturation(seedLike());
    // weighted = 3·3 + 3·2 + 4·1 = 19；score = round(100·19/(19+12)) = 61
    expect(s.score).toBe(61);
    expect(s.score).not.toBe(72);
    expect(s.level).toBe('has_room');
    expect(s.sampleSize).toBe(10);
    expect(s.confidence).toBe(0.75);
    expect(s.sufficient).toBe(true);
  });

  it('coveredPlatforms 只含可映射视频平台（抖音/B站/小红书），排除知乎/公众号/书籍/微博', () => {
    const s = computeSaturation(seedLike());
    expect(s.coveredPlatforms).toEqual(['douyin', 'bili', 'xhs']);
  });

  it('sources 由真实素材去重派生（含书籍，共 7 个），比 fixture 手写 6 个更完整且有序', () => {
    const s = computeSaturation(seedLike());
    expect(s.sources).toHaveLength(7);
    expect(s.sources).toContain('书籍《认知天性》');
    expect(s.sources).toContain('知乎');
    expect(s.sources).toEqual([...s.sources].sort());
  });

  it('不同素材结构 → 不同分数：同行密集 > 知识密集（同质化程度随竞争上升）', () => {
    const peerHeavy = [
      material('peer', '抖音'),
      material('peer', 'B站'),
      material('peer', '小红书'),
      material('peer', '抖音'),
    ];
    const knowledgeHeavy = [
      material('knowledge', '知乎'),
      material('knowledge', '公众号'),
      material('knowledge', '书籍《认知天性》'),
      material('knowledge', '知乎'),
    ];
    expect(computeSaturation(peerHeavy).score).toBeGreaterThan(computeSaturation(knowledgeHeavy).score);
  });

  it('单调性：追加同行爆款不会降低分数', () => {
    const base = seedLike();
    const more = [...base, material('peer', '抖音'), material('peer', '小红书')];
    expect(computeSaturation(more).score).toBeGreaterThanOrEqual(computeSaturation(base).score);
  });

  it('score 始终落在 0–100（大量素材不溢出）', () => {
    const many = Array.from({ length: 200 }, () => material('peer', '抖音'));
    const s = computeSaturation(many);
    expect(s.score).toBeLessThanOrEqual(100);
    expect(s.score).toBeGreaterThanOrEqual(0);
    expect(s.confidence).toBeLessThanOrEqual(1);
  });
});

describe('computeSaturation：AC-D5 样本不足不给确定性结论', () => {
  it('2 条 / 1 平台 → confidence 低（<0.5）+ sufficient false', () => {
    const s = computeSaturation([material('peer', '抖音'), material('knowledge', '知乎')]);
    expect(s.sampleSize).toBe(2);
    expect(s.coveredPlatforms).toEqual(['douyin']);
    expect(s.confidence).toBeLessThan(SATURATION_TUNING.sufficientConfidence);
    expect(s.sufficient).toBe(false);
  });

  it('样本量达阈值但平台覆盖不足 → confidence 仍低 → sufficient false（保守）', () => {
    // 6 条全部来自抖音：sampleFactor 0.6 × coverageFactor 0.25 = 0.15 < 0.5
    const s = computeSaturation(Array.from({ length: 6 }, () => material('peer', '抖音')));
    expect(s.sampleSize).toBe(6);
    expect(s.confidence).toBeLessThan(0.5);
    expect(s.sufficient).toBe(false);
  });

  it('样本充足 + 多平台覆盖 → sufficient true', () => {
    const s = computeSaturation(seedLike());
    expect(s.sufficient).toBe(true);
    expect(s.confidence).toBeGreaterThanOrEqual(0.5);
  });
});

describe('coveredPlatformsOf：去重 + 枚举序 + 非平台来源忽略', () => {
  it('重复来源去重，按 douyin/sph/bili/xhs 排序', () => {
    const ms = [
      material('hot', '小红书'),
      material('peer', '抖音'),
      material('hot', '抖音'),
      material('peer', 'B站'),
    ];
    expect(coveredPlatformsOf(ms)).toEqual(['douyin', 'bili', 'xhs']);
  });

  it('只有知乎/微博 → 无可映射平台 → []', () => {
    expect(coveredPlatformsOf([material('knowledge', '知乎'), material('hot', '微博')])).toEqual([]);
  });

  it('视频号 → sph（fixture 无此源，但映射完备）', () => {
    expect(coveredPlatformsOf([material('peer', '视频号')])).toEqual(['sph']);
  });

  it('输入顺序无关（缓存相等性）：打乱素材顺序得到同一 coveredPlatforms 与 sources', () => {
    const a = computeSaturation(seedLike());
    const b = computeSaturation([...seedLike()].reverse());
    expect(a.coveredPlatforms).toEqual(b.coveredPlatforms);
    expect(a.sources).toEqual(b.sources);
    expect(a.score).toBe(b.score);
  });
});