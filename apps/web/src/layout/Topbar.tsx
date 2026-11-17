import type { ReactNode } from 'react';
import { Breadcrumb, Button, Tag } from 'antd';
import { Link, matchPath, useLocation } from 'react-router-dom';
import { PAGE_ROUTES } from '../routes/manifest';
import { useUiStore } from '../store/ui';
import { USE_FIXTURES } from '../work/api';
import type { Breakpoint } from './useBreakpoint';
import { QuotaPill } from './Quota';

function useCrumbs(): { title: ReactNode }[] {
  const { pathname } = useLocation();
  const matched = PAGE_ROUTES.find((r) => matchPath({ path: r.path, end: true }, pathname) != null);
  const items: { title: ReactNode }[] = [{ title: <Link to="/">工作台</Link> }];
  if (matched != null && matched.section !== '工作台') items.push({ title: matched.section });
  if (matched != null && matched.path !== '/') items.push({ title: matched.title });
  return items;
}

export function Topbar({ bp }: { bp: Breakpoint }) {
  const theme = useUiStore((s) => s.theme);
  const toggleTheme = useUiStore((s) => s.toggleTheme);
  const setSidebarOpen = useUiStore((s) => s.setSidebarOpen);
  const crumbs = useCrumbs();

  return (
    <header className="topbar">
      {bp === 'wide' ? null : (
        <Button type="text" aria-label="打开主导航" onClick={() => setSidebarOpen(true)}>
          ☰
        </Button>
      )}
      <Breadcrumb items={crumbs} />
      <div className="topbar__spacer" />
      {USE_FIXTURES ? <Tag color="warning">占位数据</Tag> : null}
      <QuotaPill />
      <Button
        type="text"
        aria-label={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
        aria-pressed={theme === 'light'}
        onClick={toggleTheme}
      >
        {theme === 'dark' ? '浅色' : '深色'}
      </Button>
    </header>
  );
}