import { describe, expect, it } from 'vitest';
import { WorkStep } from '@knowstudio/contracts';
import { NO_WORK_FALLBACK, domainEntryTarget, stagePath } from '../src/work/resume';

/** SPEC §2.2 续作落地页表，workId=w1。 */
const EXPECTED: Record<(typeof WorkStep.values)[number], string> = {
  'search': '/discover',
  'topics': '/discover/topics',
  'script': '/studio/w1/script',
  'video.draft': '/studio/w1/video',
  'video.rendering': '/studio/w1/render',
  'video.rendered': '/studio/w1/video',
  'derive': '/publish/w1',
  'export': '/publish/w1/export',
  'done': '/works/w1',
};

describe('域入口重定向', () => {
  for (const step of WorkStep.values) {
    it(`最近活跃 Work 停在 ${step} 时落到 ${EXPECTED[step]}`, () => {
      expect(domainEntryTarget({ id: 'w1', step })).toBe(EXPECTED[step]);
    });
  }

  it('没有可续作作品时回作品列表', () => {
    expect(domainEntryTarget(null)).toBe(NO_WORK_FALLBACK);
    expect(domainEntryTarget(undefined)).toBe(NO_WORK_FALLBACK);
    expect(NO_WORK_FALLBACK).toBe('/works');
  });

  it('换 workId 只换 id 段，不改路径形状', () => {
    expect(domainEntryTarget({ id: 'w2', step: 'video.rendering' })).toBe('/studio/w2/render');
  });
});

describe('步进器分段落点', () => {
  it('四段分别落到该段入口 step 的续作路径', () => {
    expect(stagePath(0, 'w1')).toBe('/discover');
    expect(stagePath(1, 'w1')).toBe('/discover/topics');
    expect(stagePath(2, 'w1')).toBe('/studio/w1/video');
    expect(stagePath(3, 'w1')).toBe('/publish/w1');
  });
});