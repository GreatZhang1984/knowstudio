import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GateDetail } from '@knowstudio/contracts';
import { GateLocked } from '../src/GateLocked';

/**
 * DOM 测试环境冒烟（T-31/T-34 前置）。
 * 证明 jsdom + @testing-library/react + user-event 真实可用：
 * 组件挂到 document、按 role/text 查询、真实点击触发回调。
 * 顺带把「CTA 跳转只认服务端 redirectTo」(D-04) 锁成回归——SSR markup 测不到点击。
 */

// vitest 未开 globals，testing-library 的自动 cleanup 不会注册，这里显式清理。
afterEach(cleanup);

describe('DOM 环境冒烟：jsdom 全局真实存在', () => {
  it('document/window 可用，能创建并查询真实节点', () => {
    expect(typeof document).toBe('object');
    expect(typeof window).toBe('object');
    const probe = document.createElement('div');
    probe.textContent = '探针';
    document.body.appendChild(probe);
    expect(document.body.textContent).toContain('探针');
    probe.remove();
  });
});

describe('GateLocked 真实 DOM 渲染与交互', () => {
  const detail: GateDetail = {
    satisfied: false,
    reason: 'SCRIPT_NOT_CONFIRMED',
    redirectTo: '/studio/w1/script',
  };

  it('按 role/text 查询到标题、原因文案、reason 标签与 CTA', () => {
    render(
      <GateLocked
        requiredGate="G2"
        redirectTo="/studio/w1/video"
        detail={detail}
        onNavigate={vi.fn()}
      />,
    );
    expect(screen.getByRole('status')).toBeTruthy();
    expect(screen.getByText('文案确认门 G2未解锁')).toBeTruthy();
    expect(screen.getByText('文案还没有确认')).toBeTruthy();
    expect(screen.getByText('SCRIPT_NOT_CONFIRMED')).toBeTruthy();
    expect(screen.getByRole('button', { name: '回到上一门' })).toBeTruthy();
  });

  it('点击 CTA：onNavigate 收到服务端 detail.redirectTo，而非本地 prop（D-04）', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    render(
      <GateLocked
        requiredGate="G2"
        redirectTo="/studio/w1/video"
        detail={detail}
        onNavigate={onNavigate}
      />,
    );
    await user.click(screen.getByRole('button', { name: '回到上一门' }));
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith('/studio/w1/script');
  });

  it('无 onNavigate 时 CTA 退化为链接，href 仍用服务端 redirectTo', () => {
    const g3: GateDetail = {
      satisfied: false,
      reason: 'HD_RENDER_NOT_SUCCEEDED',
      redirectTo: '/studio/w1/render',
    };
    render(<GateLocked requiredGate="G3" redirectTo="/studio/w1/video" detail={g3} />);
    const link = screen.getByRole('link', { name: '回到上一门' });
    expect(link.getAttribute('href')).toBe('/studio/w1/render');
  });
});