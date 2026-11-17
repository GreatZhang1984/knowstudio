import { describe, expect, it } from 'vitest';
import {
  ARTIFACT_POLICY,
  DEFAULT_SIGN_TTL_SEC,
  draftKey,
  evidenceKey,
  exportKey,
  isInternalKey,
  layerKey,
  videoKey,
} from '../src/index.js';

/** 期望值逐字抄自架构 §6.8（spark-output/architecture/knowledge-video-tool.md:1522-1528）。 */
describe('产物键布局与保留策略', () => {
  it('五类产物键与 §6.8 前缀逐字一致', () => {
    expect(layerKey({ userId: 'u1', workId: 'w1', kind: 'audio', version: 3 })).toBe(
      'layers/u1/w1/audio/3',
    );
    expect(draftKey({ userId: 'u1', workId: 'w1' })).toBe('videos/u1/w1/draft');
    expect(videoKey({ userId: 'u1', workId: 'w1', variant: 'hd' })).toBe('videos/u1/w1/hd');
    expect(videoKey({ userId: 'u1', workId: 'w1', variant: 'douyin' })).toBe(
      'videos/u1/w1/douyin',
    );
    expect(exportKey({ userId: 'u1', workId: 'w1', exportId: 'e1' })).toBe('exports/u1/w1/e1');
    expect(evidenceKey({ userId: 'u1', materialId: 'm1' })).toBe('evidence/u1/m1');
  });

  it('分层产物版本号接受字符串', () => {
    expect(layerKey({ userId: 'u1', workId: 'w1', kind: 'slides', version: 'v2' })).toBe(
      'layers/u1/w1/slides/v2',
    );
  });

  it('保留期与签名有效期照抄 §6.8', () => {
    expect(ARTIFACT_POLICY.layer).toMatchObject({ retentionDays: 30, signTtlSec: 3600 });
    expect(ARTIFACT_POLICY.draft).toMatchObject({ retentionDays: 7, signTtlSec: 86_400 });
    expect(ARTIFACT_POLICY.video).toMatchObject({ retentionDays: 30, signTtlSec: 86_400 });
    expect(ARTIFACT_POLICY.export).toMatchObject({ retentionDays: 7, signTtlSec: 86_400 });
    expect(ARTIFACT_POLICY.evidence).toMatchObject({ retentionDays: 1095, signTtlSec: null });
    expect(DEFAULT_SIGN_TTL_SEC).toBe(86_400);
  });

  it('原文标 [推断] 的保留期与「≥7天」下限如实保留标记', () => {
    expect(ARTIFACT_POLICY.layer.retentionInferred).toBe(true);
    expect(ARTIFACT_POLICY.video.retentionInferred).toBe(true);
    expect(ARTIFACT_POLICY.evidence.retentionInferred).toBe(true);
    expect(ARTIFACT_POLICY.draft.retentionInferred).toBe(false);
    expect(ARTIFACT_POLICY.export.retentionIsMinimum).toBe(true);
  });

  it('授权凭证是内部产物', () => {
    expect(isInternalKey('evidence/u1/m1')).toBe(true);
    expect(isInternalKey('exports/u1/w1/e1')).toBe(false);
    expect(isInternalKey('videos/u1/w1/hd')).toBe(false);
  });

  it('拒绝能越出本人前缀的键片段', () => {
    const evil = ['../other', 'a/b', 'a\\b', '', '.', '..', 'u\u00001', 'w\n1'];
    for (const value of evil) {
      expect(() => draftKey({ userId: value, workId: 'w1' })).toThrow(/非法存储键片段 userId/);
      expect(() => draftKey({ userId: 'u1', workId: value })).toThrow(/非法存储键片段 workId/);
      expect(() => exportKey({ userId: 'u1', workId: 'w1', exportId: value })).toThrow(
        /非法存储键片段 exportId/,
      );
      expect(() => evidenceKey({ userId: 'u1', materialId: value })).toThrow(
        /非法存储键片段 materialId/,
      );
      expect(() => layerKey({ userId: 'u1', workId: 'w1', kind: value, version: 1 })).toThrow(
        /非法存储键片段 kind/,
      );
      expect(() => videoKey({ userId: 'u1', workId: 'w1', variant: value })).toThrow(
        /非法存储键片段 variant/,
      );
    }
  });

  it('正常的 UUID / 中文片段不被误杀', () => {
    expect(draftKey({ userId: '3f40e73c-90bb', workId: 'w-1_2' })).toBe(
      'videos/3f40e73c-90bb/w-1_2/draft',
    );
    expect(layerKey({ userId: 'u1', workId: 'w1', kind: '字幕', version: 1 })).toBe(
      'layers/u1/w1/字幕/1',
    );
  });
});