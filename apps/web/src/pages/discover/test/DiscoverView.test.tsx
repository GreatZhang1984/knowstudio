import { createElement } from 'react';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { beforeAll, describe, expect, it } from 'vitest';
import { NotFound } from '@knowstudio/contracts';
import type { Material, SearchSession } from '@knowstudio/contracts';
import { DiscoverView } from '../DiscoverView';
import { searchViewState } from '../searchLogic';
import type { DiscoverViewProps } from '../DiscoverView';

beforeAll(() => {
  (globalThis as { matchMedia?: unknown }).matchMedia = (query: string) => ({
    matches: query.includes('960'),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  });
});

const material = (id: string, type: Material['type'], collected: boolean): Material => ({
  id,
  type,
  title: `素材 ${id}`,
  summary: `这是 ${id} 的摘要，用于验证卡片信息完整。`,
  source: type === 'knowledge' ? '知乎' : type === 'hot' ? '抖音' : 'B站',
  url: null,
  license: collected ? 'cleared' : 'unknown',
  collected,
});

const successfulSession: SearchSession = {
  id: 'ss_1',
  keyword: '费曼学习法',
  status: 'succeeded',
  materials: [
    material('mat_k1', 'knowledge', true),
    material('mat_h1', 'hot', false),
    material('mat_p1', 'peer', false),
  ],
  saturation: {
    score: 72,
    level: 'saturated',
    confidence: 0.86,
    sampleSize: 10,
    coveredPlatforms: ['douyin', 'sph', 'bili', 'xhs'],
    sources: ['知乎', '抖音', 'B站'],
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
};

const base: DiscoverViewProps = {
  workId: 'w1',
  workTitle: '费曼学习法',
  workLoading: false,
  keyword: '费曼学习法',
  domain: '',
  materialSources: [
    { id: 'recorded', name: '录制演示', description: '内置素材', configured: true },
    { id: 'web_search', name: 'Web 搜索', description: '真实网页', configured: true },
    { id: 'obsidian', name: 'Obsidian', description: '未配置 MCP', configured: false },
  ],
  selectedSourceIds: ['recorded'],
  sourcesLoading: false,
  sameResult: false,
  submitting: false,
  session: successfulSession,
  view: searchViewState({ session: successfulSession }),
  error: null,
  collectError: null,
  collectFailed: false,
  collectingMaterialId: null,
  onKeywordChange: () => {},
  onDomainChange: () => {},
  onToggleSource: () => {},
  onSubmit: () => {},
  onRetry: () => {},
  onToggleCollect: () => {},
};

function render(props: Partial<DiscoverViewProps> = {}): string {
  const view = createElement(
    MemoryRouter,
    null,
    createElement(DiscoverView, { ...base, ...props }),
  );
  return renderToStaticMarkup(view as ReactElement);
}

const countOf = (markup: string, needle: string): number => markup.split(needle).length - 1;

describe('DiscoverView 五态', () => {
  it('initial：渲染搜索表单、当前作品与初始引导，不渲染假结果', () => {
    const markup = render({
      session: null,
      view: { kind: 'initial' },
    });
    expect(markup).toContain('data-testid="discover-initial"');
    expect(markup).toContain('当前作品');
    expect(markup).toContain('费曼学习法');
    expect(markup).not.toContain('data-testid="discover-loading"');
  });

  it('loading：3×3 骨架与聚合提示，不把空结果误报为空态', () => {
    const queued: SearchSession = { ...successfulSession, status: 'running', materials: [] };
    const markup = render({
      session: queued,
      view: searchViewState({ session: queued }),
    });
    expect(markup).toContain('data-testid="discover-loading"');
    expect(countOf(markup, 'ks-skel__cell')).toBe(9);
    expect(markup).not.toContain('data-testid="discover-empty"');
  });

  it('success：饱和度、置信度、样本量、来源、三类素材与授权标识齐全', () => {
    const markup = render();
    expect(markup).toContain('aria-label="饱和度 72，讲的人很多"');
    expect(markup).toContain('86%');
    expect(markup).toContain('10');
    expect(markup).toContain('知乎、抖音、B站');
    expect(markup).toContain('知识素材');
    expect(markup).toContain('热点角度');
    expect(markup).toContain('同行爆款');
    expect(markup).toContain('可商用');
    expect(markup).toContain('授权未知');
    expect(markup).toContain('已收藏 1 条素材');
  });

  it('success：空白角度携带 label 进入选题页', () => {
    const markup = render();
    expect(markup).toContain('materials=mat_k1');
    const angle = encodeURIComponent('费曼 × 职场汇报').replace(/%20/g, '+');
    expect(markup).toContain(`angle=${angle}`);
  });

  it('empty：无结果时给换词建议，不渲染饱和度结论', () => {
    const empty: SearchSession = {
      ...successfulSession,
      materials: [],
      saturation: null,
      blankAngles: [],
    };
    const markup = render({ session: empty, view: searchViewState({ session: empty }) });
    expect(markup).toContain('data-testid="discover-empty"');
    expect(markup).toContain('当前录制源只包含示例关键词');
    expect(markup).not.toContain('饱和度 72');
  });

  it('error：渲染错误态与重试动作；输入保留在表单里', () => {
    const failed: SearchSession = { ...successfulSession, status: 'failed', materials: [] };
    const markup = render({
      session: failed,
      view: searchViewState({ session: failed }),
      error: NotFound.parse({
        code: 'NOT_FOUND',
        message: '作品不存在',
        details: {},
      }),
    });
    expect(markup).toContain('data-testid="discover-error"');
    expect(markup).toContain('重试聚合');
    expect(markup).toContain('value="费曼学习法"');
  });

  it('partial：成功素材可用，同时逐项展示失败来源', () => {
    const partial: SearchSession = {
      ...successfulSession,
      partialErrors: [{ source: 'recorded:knowledge', code: 'SOURCE_FAILED', message: '超时' }],
    };
    const markup = render({
      session: partial,
      view: searchViewState({ session: partial }),
    });
    expect(markup).toContain('部分来源没有返回');
    expect(markup).toContain('recorded:knowledge');
    expect(markup).toContain('超时');
    expect(markup).not.toContain('data-testid="discover-loading"');
  });

  it('数据不足：饱和度可见但明确降级为“仅供参考”', () => {
    const insufficient: SearchSession = {
      ...successfulSession,
      saturation: { ...successfulSession.saturation!, sufficient: false },
    };
    const markup = render({
      session: insufficient,
      view: searchViewState({ session: insufficient }),
    });
    expect(markup).toContain('数据不足，仅供参考');
  });
});

describe('DiscoverView 交互锚点', () => {
  it('同关键词重复提交时按钮显示已是最新结果并禁用', () => {
    const markup = render({ sameResult: true });
    expect(markup).toContain('已是最新结果');
    expect(markup).toContain('disabled');
  });

  it('未收藏素材时去选题给出可见原因，不静默禁用', () => {
    const noneCollected: SearchSession = {
      ...successfulSession,
      materials: successfulSession.materials.map((m) => ({ ...m, collected: false })),
    };
    const markup = render({
      session: noneCollected,
      view: searchViewState({ session: noneCollected }),
    });
    expect(markup).toContain('先收藏至少一条素材');
  });

  it('素材源可多选，未配置源禁用且说明配置状态', () => {
    const markup = render();
    expect(markup).toContain('素材源');
    expect(markup).toContain('录制演示');
    expect(markup).toContain('Web 搜索');
    expect(markup).toContain('Obsidian');
    expect(markup).toContain('未配置 MCP');
    expect(markup).toContain('disabled');
  });

  it('收藏失败展示错误态，下一次操作前不残留成功假象', () => {
    const markup = render({
      collectFailed: true,
      collectError: null,
    });
    expect(markup).toContain('data-testid="discover-collect-error"');
    expect(markup).toContain('收藏没有生效');
  });
});
