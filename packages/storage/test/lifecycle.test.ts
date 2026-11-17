import { describe, expect, it } from 'vitest';
import { ARTIFACT_TAG, artifactTagging, buildLifecycleRules } from '../src/index.js';

describe('桶级 Lifecycle Rule（架构 §6.8）', () => {
  const rules = buildLifecycleRules();

  it('五类产物各一条规则，全部启用', () => {
    expect(rules).toHaveLength(5);
    expect(rules.every((r) => r.Status === 'Enabled')).toBe(true);
    expect(new Set(rules.map((r) => r.ID)).size).toBe(5);
  });

  it('layers / exports / evidence 用纯前缀过滤', () => {
    const byId = new Map(rules.map((r) => [r.ID, r]));
    expect(byId.get('knowstudio-layer-30d')).toMatchObject({
      Filter: { Prefix: 'layers/' },
      Expiration: { Days: 30 },
    });
    expect(byId.get('knowstudio-export-7d')).toMatchObject({
      Filter: { Prefix: 'exports/' },
      Expiration: { Days: 7 },
    });
    expect(byId.get('knowstudio-evidence-1095d')).toMatchObject({
      Filter: { Prefix: 'evidence/' },
      Expiration: { Days: 1095 },
    });
  });

  it('草稿 7 天与高清 30 天共用 videos/ 前缀，靠 artifact 标签判别', () => {
    const byId = new Map(rules.map((r) => [r.ID, r]));
    expect(byId.get('knowstudio-draft-7d')).toMatchObject({
      Filter: { And: { Prefix: 'videos/', Tags: [{ Key: ARTIFACT_TAG, Value: 'draft' }] } },
      Expiration: { Days: 7 },
    });
    expect(byId.get('knowstudio-video-30d')).toMatchObject({
      Filter: { And: { Prefix: 'videos/', Tags: [{ Key: ARTIFACT_TAG, Value: 'video' }] } },
      Expiration: { Days: 30 },
    });
  });

  it('标签串与规则里的标签一致，写入端不会拼错', () => {
    expect(artifactTagging('draft')).toBe('artifact=draft');
    expect(artifactTagging('video')).toBe('artifact=video');
    expect(ARTIFACT_TAG).toBe('artifact');
  });
});