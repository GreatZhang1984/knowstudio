import type { CSSProperties } from 'react';
import { Progress } from 'antd';
import { NavLink, useNavigate } from 'react-router-dom';
import { StageStepper, stageVars } from '@knowstudio/ui';
import { NAV_ITEMS } from '../routes/manifest';
import { useUiStore } from '../store/ui';
import { useCurrentWork } from '../work/queries';
import { stagePath } from '../work/resume';
import { QuotaBar } from './Quota';

export function Sidebar({ onNavigated }: { onNavigated?: () => void }) {
  const theme = useUiStore((s) => s.theme);
  const navigate = useNavigate();
  const { workId, envelope } = useCurrentWork();
  const work = envelope.data;

  // 阶段色只注入到这个容器，AntD 全局主色不随阶段变化（架构 §11.4）。
  const style = work == null ? undefined : (stageVars(work.phase, theme) as CSSProperties);

  return (
    <div className="sidebar" style={style}>
      <div className="sidebar__brand">
        知影工坊<span>KnowStudio</span>
      </div>

      <nav className="sidebar__nav" aria-label="主导航">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            className={({ isActive }) => `nav-link${isActive ? ' is-active' : ''}`}
            onClick={onNavigated}
          >
            {item.label}
          </NavLink>
        ))}
      </nav>

      <section className="sidebar__work" aria-label="当前作品">
        <h2 className="sidebar__caption">当前作品</h2>
        {work == null ? (
          <p className="sidebar__empty">暂无进行中作品</p>
        ) : (
          <>
            <p className="sidebar__work-title">{work.title}</p>
            <StageStepper
              phase={work.phase}
              compact
              onSelect={(stage) => {
                if (workId == null) return;
                void navigate(stagePath(stage.phase, workId));
                onNavigated?.();
              }}
            />
            <Progress percent={work.progress} size="small" strokeColor="var(--stage-c)" />
          </>
        )}
      </section>

      <div className="sidebar__quota">
        <QuotaBar />
      </div>
    </div>
  );
}