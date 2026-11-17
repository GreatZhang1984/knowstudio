import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { WorkStep } from '@knowstudio/contracts';
import type { WorkListItem } from '@knowstudio/contracts';
import { resumePath } from '@knowstudio/domain';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as RouterModule from 'react-router-dom';
import { DomainEntryRedirect } from '../src/routes/DomainEntryRedirect';
import { buildRouteObjects } from '../src/routes/router';
import { NO_WORK_FALLBACK, domainEntryTarget } from '../src/work/resume';
import { workKeys } from '../src/work/queries';

/**
 * 域入口 `/studio` `/publish` 的三态。
 *
 * Navigate 在 SSR 下不跑 effect，所以用探针记录它的 to；
 * 真实浏览器的落点由实测覆盖。取数行为用 api 缝隙的替身控制——
 * 调用方只认 api.ts 这一层，T-10 落地时换实现不动这里。
 */
const captured = vi.hoisted(() => ({ to: [] as string[] }));
const backend = vi.hoisted(() => ({ mode: 'ok' as 'ok' | 'empty' | 'error' }));

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof RouterModule>();
  return {
    ...actual,
    Navigate: (props: { to: string }) => {
      captured.to.push(props.to);
      return h('div', { 'data-redirect': props.to }, 'redirecting');
    },
  };
});

vi.mock('../src/work/api', () => ({
  USE_FIXTURES: true,
  fetchRecentWork: (): Promise<WorkListItem | null> => {
    if (backend.mode === 'error') return Promise.reject(new Error('GET /api/works 失败：HTTP 503'));
    if (backend.mode === 'empty') return Promise.resolve(null);
    return Promise.resolve({
      id: 'w7',
      title: '域入口探针',
      keyword: '探针',
      phase: 2,
      step: 'video.rendering',
      progress: 70,
      gates: { G1: true, G2: true, G3: false, G4: false },
      updatedAt: '2026-11-12T10:20:00Z',
    });
  },
  fetchWorkEnvelope: () => Promise.reject(new Error('本用例不该取信封')),
  fetchQuota: () => Promise.reject(new Error('本用例不该取额度')),
}));

function renderEntry(): string {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false, gcTime: Infinity } },
  });
  return renderToStaticMarkup(
    h(
      QueryClientProvider,
      { client: qc },
      h(MemoryRouter, { initialEntries: ['/studio'] }, h(DomainEntryRedirect)),
    ),
  );
}

/** 先把最近活跃 Work 灌进缓存，模拟 loader 已经预取完成的那一帧。 */
function renderEntryWithCache(data: WorkListItem | null | undefined, error?: Error): string {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false, gcTime: Infinity } },
  });
  if (error != null) {
    qc.setQueryDefaults(workKeys.recent, { retry: false });
    qc.getQueryCache().build(qc, { queryKey: workKeys.recent }).setState({
      error,
      errorUpdatedAt: Date.now(),
      status: 'error',
      fetchFailureCount: 1,
    });
  } else {
    qc.setQueryData(workKeys.recent, data);
  }
  return renderToStaticMarkup(
    h(
      QueryClientProvider,
      { client: qc },
      h(MemoryRouter, { initialEntries: ['/studio'] }, h(DomainEntryRedirect)),
    ),
  );
}

beforeEach(() => {
  captured.to.length = 0;
  backend.mode = 'ok';
});

describe('域入口 · loading 态', () => {
  it('首帧是骨架而不是白屏，也不会先乱跳一次', () => {
    const html = renderEntry();
    expect(html).toContain('aria-busy="true"');
    expect(html.trim().length).toBeGreaterThan(0);
    expect(captured.to).toEqual([]);
  });
});

describe('域入口 · 有最近活跃 Work', () => {
  it('落到该 Work 的 step 续作路径（与 domain.resumePath 逐字一致）', () => {
    const html = renderEntryWithCache({
      id: 'w7',
      title: '域入口探针',
      keyword: '探针',
      phase: 2,
      step: 'video.rendering',
      progress: 70,
      gates: { G1: true, G2: true, G3: false, G4: false },
      updatedAt: '2026-11-12T10:20:00Z',
    });
    expect(captured.to).toEqual([resumePath('video.rendering', 'w7')]);
    expect(captured.to).toEqual(['/studio/w7/render']);
    expect(html).toContain('data-redirect="/studio/w7/render"');
  });

  it('9 个 step 的落点都等于 resumePath，且都不是域入口自身（不会死循环）', () => {
    for (const step of WorkStep.values) {
      const target = domainEntryTarget({ id: 'w7', step });
      expect(target, step).toBe(resumePath(step, 'w7'));
      expect(target, step).not.toBe('/studio');
      expect(target, step).not.toBe('/publish');
    }
  });
});

describe('域入口 · 无 Work', () => {
  it('回作品列表，且 /works 是真实页面不会再被弹回来', () => {
    const html = renderEntryWithCache(null);
    expect(captured.to).toEqual([NO_WORK_FALLBACK]);
    expect(NO_WORK_FALLBACK).toBe('/works');
    expect(html).toContain('data-redirect="/works"');
    expect(domainEntryTarget(undefined)).toBe('/works');
  });

  it('后端返回空列表（fetchRecentWork → null）时同样回作品列表', async () => {
    backend.mode = 'empty';
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const objects = buildRouteObjects(qc);
    const shell = objects.find((o) => o.children != null);
    const entry = (shell?.children ?? []).find((o) => o.path === '/studio');
    const loader = entry?.loader as () => Promise<unknown>;
    await expect(loader()).resolves.toBeNull();
    expect(qc.getQueryData(workKeys.recent)).toBeNull();
    expect(domainEntryTarget(qc.getQueryData(workKeys.recent) ?? null)).toBe('/works');
  });
});

describe('域入口 · 取数失败', () => {
  it('停在原地给错误态 + 重试 + 去作品列表，绝不 Navigate（否则就是重定向死循环）', () => {
    const html = renderEntryWithCache(undefined, new Error('GET /api/works 失败：HTTP 503'));
    expect(captured.to, '失败态一旦 Navigate 就会反复重定向').toEqual([]);
    expect(html).toContain('取不到最近活跃的作品');
    expect(html).toContain('HTTP 503');
    // AntD 会在两个汉字之间插空格（「重 试」），按去空白后的文本断言。
    expect(html.replace(/\s+/g, '')).toContain('重试');
    expect(html).toContain('href="/works"');
    expect(html).not.toContain('aria-busy="true"');
  });

  it('loader 吞掉失败，不把整页交给 errorElement', async () => {
    backend.mode = 'error';
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const objects = buildRouteObjects(qc);
    const shell = objects.find((o) => o.children != null);
    for (const path of ['/studio', '/publish']) {
      const entry = (shell?.children ?? []).find((o) => o.path === path);
      expect(entry?.loader, path).toBeTypeOf('function');
      const loader = entry?.loader as () => Promise<unknown>;
      await expect(loader()).resolves.toBeNull();
    }
    expect(qc.getQueryState(workKeys.recent)?.status).toBe('error');
  });
});