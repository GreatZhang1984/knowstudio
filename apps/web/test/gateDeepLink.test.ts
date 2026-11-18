import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, RouterProvider, Routes, createMemoryRouter } from 'react-router-dom';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildRouteObjects } from '../src/routes/router';
import { PAGE_ROUTES, REDIRECT_ROUTES } from '../src/routes/manifest';
import { USE_FIXTURES } from '../src/work/api';
import { FIXTURE_WORKS } from '../src/work/fixtures';
import { gateViewOf, prefetchWorkEnvelope } from '../src/work/gateLoader';
import { workKeys } from '../src/work/queries';
import { WorkGate } from '../src/work/WorkGate';

/**
 * 深链防护（T-15 / 架构 §5.5）。
 * 用真实路由树 + 真实 loader + 真实信封 fixture 跑，不 mock 判定逻辑。
 * vitest environment=node，这里补一个 matchMedia 垫片让 AppLayout 能在 SSR 下渲染；
 * 垫片只影响测试环境，不改应用代码。
 */
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

function newClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: 30_000,
        gcTime: Infinity,
        // SSR 不跑 effect，观察者没有监听者时 react-query 会给「无数据的错误查询」
        // 算出一个乐观 pending 结果（准备挂载即重试）。这里关掉挂载重试，
        // 让首帧稳定停在缓存里的 error 分支——真实浏览器里的重试循环由实测覆盖。
        retryOnMount: false,
      },
    },
  });
}

type MemoryRouterHandle = ReturnType<typeof createMemoryRouter>;

async function initRouter(router: MemoryRouterHandle): Promise<void> {
  router.initialize();
  if (router.state.initialized) return;
  await new Promise<void>((resolve) => {
    const unsub = router.subscribe((state) => {
      if (state.initialized) {
        unsub();
        resolve();
      }
    });
  });
}

/** 走完整路由树（含 loader 与 AppLayout）后渲染首帧。 */
async function renderDeepLink(path: string, qc: QueryClient): Promise<string> {
  const router = createMemoryRouter(buildRouteObjects(qc), { initialEntries: [path] });
  await initRouter(router);
  return renderToStaticMarkup(
    h(QueryClientProvider, { client: qc }, h(RouterProvider, { router })),
  );
}

describe('路由树：19 页 + 2 域入口在 loader 改造后原样保留', () => {
  it('页面路径与重定向一个不多一个不少', () => {
    const objects = buildRouteObjects(newClient());
    const shell = objects.find((o) => o.children != null);
    const paths = [
      ...objects.filter((o) => o.path != null).map((o) => o.path),
      ...(shell?.children ?? []).map((o) => o.path),
    ];
    for (const r of PAGE_ROUTES) expect(paths, r.pageId).toContain(r.path);
    for (const r of REDIRECT_ROUTES) expect(paths, r.path).toContain(r.path);
    expect(PAGE_ROUTES).toHaveLength(19);
    expect(REDIRECT_ROUTES.map((r) => r.path)).toEqual(['/studio', '/publish']);
  });

  it('四个门控页都挂了 loader；素材详情的 :id 不会被当成 workId 去取信封', () => {
    const qc = newClient();
    const objects = buildRouteObjects(qc);
    const shell = objects.find((o) => o.children != null);
    const all = [...objects, ...(shell?.children ?? [])];
    const byPath = new Map(all.map((o) => [o.path, o]));

    for (const r of PAGE_ROUTES.filter((x) => x.gate != null)) {
      expect(typeof byPath.get(r.path)?.loader, r.path).toBe('function');
    }
    expect(byPath.get('/library/:id')?.loader).toBeUndefined();
    expect(byPath.get('/discover')?.loader).toBeUndefined();
    for (const r of REDIRECT_ROUTES) {
      expect(typeof byPath.get(r.path)?.loader, r.path).toBe('function');
    }
  });
});

describe('loader 在导航提交前就把服务端信封取回来', () => {
  it('USE_FIXTURES 在测试环境为真（否则本用例会打到真实网络）', () => {
    expect(USE_FIXTURES).toBe(true);
  });

  it('跑 /studio/:id/video 的 loader 后，信封已在 workKeys.envelope 缓存里', async () => {
    const qc = newClient();
    const objects = buildRouteObjects(qc);
    const shell = objects.find((o) => o.children != null);
    const video = [...objects, ...(shell?.children ?? [])].find(
      (o) => o.path === '/studio/:id/video',
    );
    expect(video?.loader).toBeTypeOf('function');

    const loader = video?.loader;
    if (typeof loader !== 'function') throw new Error('video 路由没有 loader');
    await loader({
      params: { id: 'w2' },
      request: new Request('http://localhost/studio/w2/video'),
    });

    const cached = qc.getQueryData(workKeys.envelope('w2'));
    expect(cached).toEqual(FIXTURE_WORKS.get('w2'));
    // 别的 Work 一把缓存都没被顺带创建。
    expect(qc.getQueryData(workKeys.envelope('w1'))).toBeUndefined();
  });

  it('取数失败不在 loader 里抛：整页不会被 errorElement 接走', async () => {
    const qc = newClient();
    await expect(prefetchWorkEnvelope(qc, 'w404')).resolves.toBeNull();
    expect(qc.getQueryState(workKeys.envelope('w404'))?.status).toBe('error');
  });

  it('没有 workId 时不发请求', async () => {
    const qc = newClient();
    await expect(prefetchWorkEnvelope(qc, undefined)).resolves.toBeNull();
    await expect(prefetchWorkEnvelope(qc, '')).resolves.toBeNull();
    expect(qc.getQueryCache().getAll()).toHaveLength(0);
  });
});

describe('gateViewOf 只读服务端 gateDetails，不碰 gates 布尔位', () => {
  it('未满足的门 → locked，落地页取 detail.redirectTo', () => {
    const w2 = FIXTURE_WORKS.get('w2');
    expect(w2).toBeDefined();
    const view = gateViewOf(w2!, 'G2');
    expect(view.kind).toBe('locked');
    if (view.kind !== 'locked') throw new Error('unreachable');
    expect(view.redirectTo).toBe(w2!.gateDetails.G2?.redirectTo);
    expect(view.detail.reason).toBe('SCRIPT_NOT_CONFIRMED');
  });

  it('已满足的门 → ready（w1 的 G2 已确认，不该被误锁）', () => {
    expect(gateViewOf(FIXTURE_WORKS.get('w1')!, 'G2').kind).toBe('ready');
  });

  it('把 gates 布尔位改成相反值也不影响判定：判定只认 gateDetails', () => {
    const w2 = FIXTURE_WORKS.get('w2')!;
    const tampered = { ...w2, gates: { ...w2.gates, G2: true } };
    expect(gateViewOf(tampered, 'G2').kind).toBe('locked');
    const cleared = { ...w2, gateDetails: {} };
    expect(gateViewOf(cleared, 'G2').kind).toBe('ready');
  });

  it('三份 fixture × 四个门，判定与服务端详情逐条一致', () => {
    for (const w of FIXTURE_WORKS.values()) {
      for (const gate of ['G1', 'G2', 'G3', 'G4'] as const) {
        const detail = w.gateDetails[gate];
        const view = gateViewOf(w, gate);
        if (detail == null) expect(view.kind, `${w.id}/${gate}`).toBe('ready');
        else {
          expect(view.kind, `${w.id}/${gate}`).toBe('locked');
          if (view.kind === 'locked') expect(view.redirectTo).toBe(detail.redirectTo);
        }
      }
    }
  });
});

describe('AC · 深链未满足闸门 → 首帧就是锁定态，CTA 落地页等于服务端 redirectTo', () => {
  it('/studio/w2/video 未确认文案：首帧锁定，无骨架中间帧', async () => {
    const html = await renderDeepLink('/studio/w2/video', newClient());
    expect(html).toContain('文案确认门 G2未解锁');
    expect(html).toContain('SCRIPT_NOT_CONFIRMED');
    expect(html).toContain('回到上一门');
    expect(html, '首帧还在 loading 说明 loader 没起作用').not.toContain('aria-busy="true"');
    expect(html).not.toContain('page-video');
  });

  it('CTA 只渲染「回到上一门」，落地页由服务端 redirectTo 决定（见 gateCta.test.ts 的逐字断言）', async () => {
    const html = await renderDeepLink('/studio/w2/video', newClient());
    expect(html).toContain('回到上一门');
    expect(html).toContain('ks-gate-locked');
    // 锁定态里不该出现任何前端自拼的落地页。
    expect(html).not.toContain('href="/studio/w2/video"');
  });

  it('/publish/w2/export 未满足 G4：同样锁定', async () => {
    const html = await renderDeepLink('/publish/w2/export', newClient());
    expect(html).toContain('合规门 G4未解锁');
    expect(html).toContain('COMPLIANCE_REPORT_MISSING');
    expect(html).not.toContain('page-export');
  });

  it('/studio/w1/video 已确认文案：闸门放行，首帧只剩懒加载 chunk 的骨架', async () => {
    const html = await renderDeepLink('/studio/w1/video', newClient());
    expect(html).not.toContain('未解锁');
    expect(html).not.toContain('取不到作品状态');
    // 页面本体是 React.lazy，SSR 下必然是 Suspense 占位——这正好证明 chunk 边界没被破坏。
    expect(html).toContain('aria-busy="true"');
  });

  it('取不到信封时是页面内错误态，不是白屏也不是放行', async () => {
    const html = await renderDeepLink('/studio/w404/video', newClient());
    expect(html).toContain('取不到作品状态');
    expect(html).toContain('占位数据里没有作品 w404');
    expect(html).not.toContain('未解锁');
    expect(html).not.toContain('page-video');
  });

  it('组件级兜底：不经 loader 直接挂 WorkGate 也能独立锁定', () => {
    const qc = newClient();
    qc.setQueryData(workKeys.envelope('w2'), FIXTURE_WORKS.get('w2'));
    const html = renderToStaticMarkup(
      h(
        QueryClientProvider,
        { client: qc },
        h(
          // 直接给路由上下文，不走 buildRouteObjects，模拟绕过 loader 的挂载路径。
          MemoryRouter,
          { initialEntries: ['/studio/w2/video'] },
          h(
            Routes,
            null,
            h(Route, {
              path: '/studio/:id/video',
              element: h(WorkGate, { gate: 'G2', children: h('div', null, 'page-video') }),
            }),
          ),
        ),
      ),
    );
    expect(html).toContain('文案确认门 G2未解锁');
    expect(html).toContain('SCRIPT_NOT_CONFIRMED');
    expect(html).not.toContain('page-video');
  });

  it('组件级兜底：门已满足时正常渲染子节点', () => {
    const qc = newClient();
    qc.setQueryData(workKeys.envelope('w1'), FIXTURE_WORKS.get('w1'));
    const html = renderToStaticMarkup(
      h(
        QueryClientProvider,
        { client: qc },
        h(
          MemoryRouter,
          { initialEntries: ['/studio/w1/video'] },
          h(
            Routes,
            null,
            h(Route, {
              path: '/studio/:id/video',
              element: h(WorkGate, { gate: 'G2', children: h('div', null, 'page-video') }),
            }),
          ),
        ),
      ),
    );
    expect(html).toContain('page-video');
    expect(html).not.toContain('未解锁');
  });
});
