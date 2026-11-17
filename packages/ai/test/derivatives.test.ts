import { describe, expect, it } from 'vitest';
import { generateDerivativeMetadata } from '../src/derivatives/generate';

describe('T-51 元数据派生生成器', () => {
  it('按四平台规则产出标题、标签和时长版本', () => {
    const rows = generateDerivativeMetadata({
      keyword: '费曼学习法',
      hook: '别再死记硬背了',
      rules: [
        { platformId: 'douyin', titleMax: 30, tagMax: 4, maxDurationSec: 60 },
        { platformId: 'bili', titleMax: 80, tagMax: 4, maxDurationSec: 90 },
      ],
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]?.platformId).toBe('douyin');
    expect(rows[0]?.durationVersion).toBe('essence30');
    expect(rows[1]?.platformId).toBe('bili');
    expect(rows[1]?.title).toContain('费曼学习法');
  });
});
