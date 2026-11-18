/**
 * dev 录制组合根（KNOWSTUDIO_DEV_LLM_KEYWORDS 额外关键词）单测。
 *
 * 验收口径：
 *  - 解析：逗号分隔、trim、去重（按规范化关键词）、过滤空段；
 *  - 额外关键词获得 topics（两批次）+ script 录制，且 hook/台词带「关键词：」前缀标示占位；
 *  - 种子词重复传入不产生新键（录制集合与默认一致）；
 *  - 默认（无额外关键词）录制集合不变，保证测试/CI 断言零影响。
 */
import { describe, expect, it } from 'vitest';
import { llmRecordingKey } from '@knowstudio/ai';
import { loadSeedData } from '@knowstudio/db';
import {
  buildDevRecordingStores,
  parseExtraDevKeywords,
} from '../src/discover/dev-fixtures.js';

describe('parseExtraDevKeywords', () => {
  it('解析、trim、按规范化去重、过滤空段', () => {
    expect(parseExtraDevKeywords(undefined)).toEqual([]);
    expect(parseExtraDevKeywords('')).toEqual([]);
    expect(parseExtraDevKeywords(' , ,')).toEqual([]);
    expect(parseExtraDevKeywords('SPEC驱动开发')).toEqual(['SPEC驱动开发']);
    expect(parseExtraDevKeywords('SPEC驱动开发, 刻意练习 ,spec驱动开发')).toEqual([
      'SPEC驱动开发',
      '刻意练习',
    ]);
  });
});

describe('buildDevRecordingStores', () => {
  it('额外关键词获得带前缀的 topics/script 录制', () => {
    const seed = loadSeedData();
    const { llmStore } = buildDevRecordingStores(seed, ['SPEC驱动开发']);

    const batch0 = llmStore.get(llmRecordingKey('topics', 'SPEC驱动开发:0'));
    const batch1 = llmStore.get(llmRecordingKey('topics', 'SPEC驱动开发:1'));
    const script = llmStore.get(llmRecordingKey('script', 'SPEC驱动开发'));
    expect(Array.isArray(batch0) && batch0.length === seed.topics.length).toBe(true);
    expect(Array.isArray(batch1) && batch1.length === seed.topics.length).toBe(true);
    expect(Array.isArray(script) && script.length === seed.script.sections.length).toBe(true);
    // 占位录制必须带「关键词：」前缀，诚实标示非真实生成（D-08）。
    expect(String((batch0 as readonly { hook: string }[])[0]?.hook)).toMatch(/^SPEC驱动开发：/);
  });

  it('种子词重复传入不产生新键；默认集合不变', () => {
    const seed = loadSeedData();
    const baseline = buildDevRecordingStores(seed, []);
    const withDuplicate = buildDevRecordingStores(seed, [seed.search.keyword]);
    expect(withDuplicate.llmStore.size).toBe(baseline.llmStore.size);
    // 默认（未设置环境变量）与空额外关键词一致。
    const defaults = buildDevRecordingStores(seed);
    expect([...defaults.llmStore.keys()].sort()).toEqual([...baseline.llmStore.keys()].sort());
  });
});
