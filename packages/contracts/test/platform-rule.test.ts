import { describe, expect, it } from 'vitest';
import { PlatformRuleSchema } from '../src/api.js';

/**
 * 回归：PlatformRule 曾臆造 orient='both'（DDL 是 ENUM('vertical','horizontal')，MySQL 拒收 1265），
 * 且漏了 name/ratio/brandColor/styleHint/updatedAt 五个 DDL 列（arch:793–812）。
 * SPEC §3.6 平台 tab「名称+色点+画幅·时长」与封面预览面向用户，缺列会逼前端硬编码（D-02）。
 * 本组让任何再次加回 'both' 或删掉这五列的改动立刻失败。
 */

const douyin = {
  platformId: 'douyin',
  version: 1,
  name: '抖音',
  ratio: '9:16',
  isCurrent: true,
  titleMax: 30,
  titleHardMax: 60,
  tagMax: 4,
  maxDurationSec: 60,
  orient: 'vertical',
  brandColor: '#fe2c55',
  styleHint: '情绪强·节奏快',
  bannedPatterns: [],
  updatedAt: '2026-11-13T00:00:00Z',
} as const;

describe('PlatformRule orient 值域与 DDL 逐字一致', () => {
  it('只接受 vertical / horizontal，臆造的 both 被拒', () => {
    expect([...PlatformRuleSchema.shape.orient.options]).toEqual(['vertical', 'horizontal']);
    expect(PlatformRuleSchema.parse({ ...douyin, orient: 'vertical' }).orient).toBe('vertical');
    expect(PlatformRuleSchema.parse({ ...douyin, orient: 'horizontal' }).orient).toBe('horizontal');
    expect(PlatformRuleSchema.safeParse({ ...douyin, orient: 'both' }).success).toBe(false);
    expect(PlatformRuleSchema.safeParse({ ...douyin, orient: 'landscape' }).success).toBe(false);
  });
});

describe('PlatformRule 补齐五个面向用户的 DDL 列', () => {
  it('SPEC §3.6 四平台种子（名称/画幅/品牌色/风格）全部通过', () => {
    const seeds = [
      douyin,
      { ...douyin, platformId: 'sph', name: '视频号', brandColor: '#07c160', styleHint: '稳重·可信', tagMax: 3 },
      { ...douyin, platformId: 'bili', name: 'B站', ratio: '16:9', orient: 'horizontal', maxDurationSec: 90, brandColor: '#00a1d6', styleHint: '深入·干货', titleMax: 80, titleHardMax: 160 },
      { ...douyin, platformId: 'xhs', name: '小红书', brandColor: '#ff2442', styleHint: '亲和·种草' },
    ];
    for (const s of seeds) expect(PlatformRuleSchema.parse(s)).toEqual(s);
  });

  it('五列都是必填：缺任一列即拒绝，杜绝前端硬编码兜底', () => {
    for (const key of ['name', 'ratio', 'brandColor', 'styleHint', 'updatedAt'] as const) {
      const partial: Record<string, unknown> = { ...douyin };
      delete partial[key];
      expect(PlatformRuleSchema.safeParse(partial).success, `缺 ${key} 应被拒绝`).toBe(false);
    }
  });

  it('updatedAt 走 UtcTimestamp（RFC3339），与其余 updated_at 同源', () => {
    expect(PlatformRuleSchema.safeParse({ ...douyin, updatedAt: '2026-11-13' }).success).toBe(false);
    expect(PlatformRuleSchema.parse(douyin).updatedAt).toBe('2026-11-13T00:00:00Z');
  });
});