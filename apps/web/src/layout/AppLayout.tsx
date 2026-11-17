import { useQuery } from '@tanstack/react-query';
import { Drawer, Progress } from 'antd';
import { Link, Outlet } from 'react-router-dom';
import { useUiStore } from '../store/ui';
import { fetchRenderJob } from '../work/api';
import { useRecentWork, useWorkEnvelope, workKeys } from '../work/queries';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import { useBreakpoint } from './useBreakpoint';

function GlobalRenderTask() {
  const recent = useRecentWork();
  const envelope = useWorkEnvelope(recent.data?.id);
  const activeJobId = envelope.data?.activeRenderJobId ?? null;
  const job = useQuery({
    queryKey: workKeys.job(recent.data?.id ?? '', activeJobId ?? ''),
    queryFn: () => fetchRenderJob(activeJobId ?? ''),
    enabled: activeJobId != null,
    refetchInterval: (query) =>
      query.state.data?.job.status === 'queued' || query.state.data?.job.status === 'running'
        ? 1000
        : false,
  });
  const parallelHint = envelope.data?.parallelHint;
  if (activeJobId == null || parallelHint?.enabled !== true) return null;
  return (
    <div className="global-task" role="status">
      <div>
        <strong>{envelope.data?.title ?? '当前作品'}</strong>
        <span>{job.data?.job.stage ?? 'queued'} · {job.data?.job.progress ?? 0}%</span>
      </div>
      <Progress percent={job.data?.job.progress ?? 0} size="small" showInfo={false} />
      <Link to={`/studio/${envelope.data?.id ?? ''}/render`}>渲染进度</Link>
      <Link className="global-task__cta" to={parallelHint.redirectTo}>
        去写平台标题
      </Link>
    </div>
  );
}

/** SPEC §2.1 布局：≥960 侧边栏常驻 250px；<960 抽屉化（汉堡 + scrim 由 Drawer 提供）。 */
export default function AppLayout() {
  const bp = useBreakpoint();
  const sidebarOpen = useUiStore((s) => s.sidebarOpen);
  const setSidebarOpen = useUiStore((s) => s.setSidebarOpen);

  return (
    <div className="shell" data-bp={bp}>
      {bp === 'wide' ? (
        <aside className="shell__side">
          <Sidebar />
        </aside>
      ) : (
        <Drawer
          open={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
          placement="left"
          width={250}
          title="主导航"
          styles={{ body: { padding: 0 } }}
        >
          <Sidebar onNavigated={() => setSidebarOpen(false)} />
        </Drawer>
      )}
      <div className="shell__main">
        <Topbar bp={bp} />
        <GlobalRenderTask />
        <main className="shell__content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
