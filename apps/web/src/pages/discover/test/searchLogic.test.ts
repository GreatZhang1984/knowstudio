import { describe, expect, it } from 'vitest';
import type { Material, SearchSession } from '@knowstudio/contracts';
import {
  normalizeSourceSelection,
  blankAngleTarget,
  isSameKeyword,
  materialGroups,
  partialItemsOf,
  searchInputIssue,
  searchViewState,
  topicsTarget,
  withMaterialCollected,
} from '../searchLogic';

const AVAILABLE_SOURCES = [
  { id: 'recorded', name: '录制演示', description: '', configured: true },
  { id: 'web_search', name: 'Web 搜索', description: '', configured: true },
  { id: 'obsidian', name: 'Obsidian', description: '', configured: false },
] as const;

const material = (id: string, type: Material['type'], collected = false): Material => ({
  id,
  type,
  title: `素材 ${id}`,
  summary: '摘要',
  source: '测试来源',
  url: null,
  license: 'cleared',
  collected,
});

const session = (overrides: Partial<SearchSession> = {}): SearchSession => ({
  id: 'ss_1',
  keyword: '费曼学习法',
  status: 'succeeded',
  materials: [material('mat_k1', 'knowledge'), material('mat_h1', 'hot')],
  saturation: {
    score: 72,
    level: 'saturated',
    confidence: 0.86,
    sampleSize: 10,
    coveredPlatforms: ['douyin', 'bili'],
    sources: ['知乎', 'B站'],
    sufficient: true,
  },
  blankAngles: [
    {
      id: 'ba_1',
      label: '费曼 × 职场汇报',
      basisMaterialIds: ['mat_k1'],
      rationale: '缺少职场场景迁移',
    },
  ],
  partialErrors: [],
  cacheHit: false,
  createdAt: '2026-11-16T02:00:00.000Z',
  ...overrides,
});

describe('搜索输入与结果判定', () => {
  it('关键词做 NFKC 归一，空宽字符不造成“假的不同关键词”', () => {
    expect(isSameKeyword(' 费曼学习法 ', '费曼学习法')).toBe(true);
    expect(isSameKeyword('费曼学习法', '间隔重复')).toBe(false);
  });

  it('输入校验覆盖空关键词、超长关键词与超长领域', () => {
    expect(searchInputIssue('', '')).toBe('先输入关键词或领域');
    expect(searchInputIssue('x'.repeat(41), '')).toBe('关键词最多 40 字');
    expect(searchInputIssue('费曼', 'x'.repeat(41))).toBe('领域偏好最多 40 字');
    expect(searchInputIssue('费曼', ' 学习方法 ')).toBeUndefined();
  });

  it('素材源选择去重排序，未配置源被移除，空选择回落录制源', () => {
    expect(
      normalizeSourceSelection(['obsidian', 'web_search', 'web_search'], AVAILABLE_SOURCES),
    ).toEqual(['web_search']);
    expect(normalizeSourceSelection(['obsidian'], AVAILABLE_SOURCES)).toEqual(['recorded']);
    expect(
      normalizeSourceSelection(['obsidian', 'recorded', 'web_search'], AVAILABLE_SOURCES),
    ).toEqual(['recorded', 'web_search']);
  });

  it('五态：无会话 initial；排队/提交 loading；空结果 empty；失败 error；成功 success', () => {
    expect(searchViewState({ session: null })).toEqual({ kind: 'initial' });
    expect(searchViewState({ session: session({ status: 'queued' }) }).kind).toBe('loading');
    expect(searchViewState({ session: session({ materials: [] }) }).kind).toBe('empty');
    expect(searchViewState({ session: session({ status: 'failed' }) }).kind).toBe('error');
    expect(searchViewState({ session: session() })).toEqual({
      kind: 'success',
      session: session(),
      partial: false,
    });
  });

  it('60 秒超时优先于仍在排队的任务状态，避免无限轮询', () => {
    const queued = session({ status: 'queued' });
    expect(searchViewState({ session: queued, timedOut: true }).kind).toBe('error');
  });

  it('partialErrors 让成功态降级为 partial，并保留逐项失败来源', () => {
    const partial = session({
      partialErrors: [{ source: 'recorded:knowledge', code: 'SOURCE_FAILED', message: '超时' }],
    });
    const state = searchViewState({ session: partial });
    expect(state).toEqual({ kind: 'success', session: partial, partial: true });
    expect(partialItemsOf(partial)).toEqual([
      {
        key: 'recorded:knowledge:SOURCE_FAILED',
        label: 'recorded:knowledge',
        status: 'failed',
        detail: '超时',
      },
    ]);
  });
});

describe('素材分组与收藏状态', () => {
  it('只把搜索三类分进三列，其他素材类型不会混入', () => {
    const groups = materialGroups([
      material('k', 'knowledge'),
      material('h', 'hot'),
      material('p', 'peer'),
      material('i', 'image'),
    ]);
    expect(groups.map((g) => g.kind)).toEqual(['knowledge', 'hot', 'peer']);
    expect(groups[0]?.materials).toHaveLength(1);
  });

  it('乐观更新只改当前素材，不影响同批其他素材', () => {
    const before = session();
    const after = withMaterialCollected(before, 'mat_k1', true);
    expect(after.materials[0]?.collected).toBe(true);
    expect(after.materials[1]?.collected).toBe(false);
    expect(before.materials[0]?.collected).toBe(false);
  });

  it('空白角度链接携带 label，选题页可读取上下文', () => {
    expect(blankAngleTarget(session().blankAngles[0]!)).toBe(
      `/discover/topics?angle=${encodeURIComponent('费曼 × 职场汇报')}`,
    );
  });

  it('选题入口携带当前已收藏素材 id，避免选题页丢失输入依据', () => {
    const withInput = withMaterialCollected(session(), 'mat_k1', true);
    const target = topicsTarget(withInput, withInput.blankAngles[0]);
    expect(target).toContain('materials=mat_k1');
    expect(target).toContain('angle=');
  });
});
