import { describe, expect, it } from 'vitest';
import type { WorkTruthSnapshot } from '@knowstudio/contracts';
import { buildComplianceReport, findTerms, type ComplianceMaterial } from '../src/index.js';

const snapshot: WorkTruthSnapshot = {
  workId: 'w1',
  selectedTopicId: 't1',
  script: { id: 's1', version: 1, status: 'confirmed', confirmedAt: '2026-01-01T00:00:00Z', contentHash: 'a'.repeat(64) },
  latestHdAsset: { id: 'v1', status: 'succeeded', stale: false, scriptVersion: 1 },
  latestCompliance: null,
  materials: [],
  derivatives: [],
  template: { templateId: 'tpl1', version: 1, fontFamily: '思源黑体' },
  bgm: null,
  lexiconVersion: 0,
};

function material(over: Partial<ComplianceMaterial> = {}): ComplianceMaterial {
  return {
    materialId: 'm1',
    type: 'image',
    title: '图片',
    license: 'cleared',
    evidenceExpiresAt: null,
    bodyText: null,
    usedIn: [],
    ...over,
  };
}

describe('findTerms', () => {
  it('一次扫描命多个受限词', () => {
    expect(findTerms('包含违禁词和平台限流词', ['违禁词', '限流词', '不存在'])).toEqual(['违禁词', '限流词']);
  });
});

describe('buildComplianceReport', () => {
  it('cleared 素材与 OFL 字段通过，指纹来自当前真相', () => {
    const report = buildComplianceReport({
      snapshot,
      materials: [material()],
      scriptLines: [{ lineId: 'l1', text: '完全原创的表达' }],
      bannedPatterns: [],
      now: '2026-01-02T00:00:00Z',
    });
    expect(report.blockingCount).toBe(0);
    expect(report.items.map((item) => item.status)).toEqual(['pass', 'pass', 'pass', 'pass']);
    expect(report.fingerprint).toHaveLength(64);
  });

  it('unknown 和 restricted 都阻断，过期凭证也阻断', () => {
    const report = buildComplianceReport({
      snapshot,
      materials: [
        material({ materialId: 'm1', license: 'unknown' }),
        material({ materialId: 'm2', license: 'cleared', evidenceExpiresAt: '2026-01-01T00:00:00Z' }),
      ],
      scriptLines: [],
      bannedPatterns: [],
      now: '2026-01-02T00:00:00Z',
    });
    const image = report.items.find((item) => item.kind === 'image');
    expect(image?.blocking).toBe(true);
    expect(image?.materialIds).toEqual(['m1', 'm2']);
  });

  it('平台受限词和连续 30 字原文命中产生 content 阻断', () => {
    const source = '这是整整三十个字的原文内容，必须足够长才能触发连续原文命中检测规则。';
    const report = buildComplianceReport({
      snapshot: { ...snapshot, derivatives: [{ platformId: 'douyin', ruleVersion: 1, title: '标题包含违禁词', tags: [] }] },
      materials: [material({ type: 'knowledge', bodyText: source })],
      scriptLines: [{ lineId: 'l1', text: source }],
      bannedPatterns: ['违禁词'],
      now: '2026-01-02T00:00:00Z',
    });
    const content = report.items.find((item) => item.kind === 'content');
    expect(content?.blocking).toBe(true);
    expect(content?.lineId).toBe('l1');
    expect(content?.detail).toContain('违禁词');
  });

  it('背景音乐缺少有效过期时间时阻断 music', () => {
    const report = buildComplianceReport({
      snapshot: { ...snapshot, bgm: { trackId: 'track_1', evidenceExpiresAt: null } },
      materials: [],
      scriptLines: [],
      bannedPatterns: [],
      now: '2026-01-02T00:00:00Z',
    });
    const music = report.items.find((item) => item.kind === 'music');
    expect(music?.blocking).toBe(true);
    expect(music?.detail).toContain('track_1');
  });
});
