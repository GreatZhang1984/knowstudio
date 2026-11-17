import { Suspense } from 'react';
import { Navigate, createBrowserRouter } from 'react-router-dom';
import type { RouteObject } from 'react-router-dom';
import type { QueryClient } from '@tanstack/react-query';
import { PageFallback } from '../components/PageFallback';
import AppLayout from '../layout/AppLayout';
import { prefetchRecentWork, prefetchWorkEnvelope } from '../work/gateLoader';
import { WorkGate } from '../work/WorkGate';
import { DomainEntryRedirect } from './DomainEntryRedirect';
import { PAGE_ROUTES, REDIRECT_ROUTES } from './manifest';
import type { PageRoute } from './manifest';

/**
 * 路由树由 manifest 派生：18 页 + 2 个域入口重定向，一个不多一个不少。
 * 页面组件仍是 manifest 里的 React.lazy，chunk 边界不变。
 */

/** 路径里的 :id 是不是 workId。`/library/:id` 是素材 id，不能拿去取 work 信封。 */
const WORK_ID_ROUTE = /^\/(studio|publish|works)\/:id(\/|$)/;

function LazyPage({ route }: { route: PageRoute }) {
  const Page = route.component;
  const body = (
    <Suspense fallback={<PageFallback />}>
      <Page />
    </Suspense>
  );
  // 组件级兜底：loader 已预取过信封，这里首帧即终态；
  // 直接挂载 <WorkGate>（绕过 loader）或缓存被清空时，它仍能独立取数并锁定。
  return route.gate == null ? body : <WorkGate gate={route.gate}>{body}</WorkGate>;
}

function pageRouteObject(route: PageRoute, queryClient: QueryClient): RouteObject {
  const base: RouteObject = { path: route.path, element: <LazyPage route={route} /> };
  if (!WORK_ID_ROUTE.test(route.path)) return base;
  return {
    ...base,
    // 门控页在导航提交前就取回 gates（架构 §5.5 路由 loader 层）；
    // 非门控的 work 页也预取，省掉「页面渲染 → 侧栏再取一次」的第二段瀑布。
    loader: ({ params }) => prefetchWorkEnvelope(queryClient, params.id),
  };
}

export function buildRouteObjects(queryClient: QueryClient): RouteObject[] {
  return [
    ...PAGE_ROUTES.filter((r) => r.shell === 'bare').map((r) => pageRouteObject(r, queryClient)),
    {
      element: <AppLayout />,
      children: [
        ...PAGE_ROUTES.filter((r) => r.shell === 'app').map((r) => pageRouteObject(r, queryClient)),
        ...REDIRECT_ROUTES.map(
          (r): RouteObject => ({
            path: r.path,
            element: <DomainEntryRedirect />,
            loader: () => prefetchRecentWork(queryClient),
          }),
        ),
      ],
    },
    { path: '*', element: <Navigate to="/" replace /> },
  ];
}

export function createAppRouter(queryClient: QueryClient) {
  return createBrowserRouter(buildRouteObjects(queryClient));
}