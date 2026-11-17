import { useMemo } from 'react';
import { RouterProvider } from 'react-router-dom';
import type { QueryClient } from '@tanstack/react-query';
import { PageFallback } from './components/PageFallback';
import { createAppRouter } from './routes/router';

/**
 * 数据路由宿主。router 只建一次（useMemo）：每次渲染重建会丢掉 loader 状态并重复取数。
 * fallbackElement 覆盖「冷启动深链、首个 loader 还没回来」这一帧——否则这里会是白屏。
 */
export default function App({ queryClient }: { queryClient: QueryClient }) {
  const router = useMemo(() => createAppRouter(queryClient), [queryClient]);
  return <RouterProvider router={router} fallbackElement={<PageFallback />} />;
}