import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import ScriptPage from '../ScriptPage';

afterEach(cleanup);

function renderScript(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        MemoryRouter,
        { initialEntries: ['/studio/w1/script'] },
        createElement(
          Routes,
          null,
          createElement(Route, { path: '/studio/:id/script', element: createElement(ScriptPage) }),
          createElement(Route, {
            path: '/studio/:id/video',
            element: createElement('div', null, '视频页'),
          }),
        ),
      ),
    ),
  );
}

describe('T-16/T-28～T-34 文案页', () => {
  it('生成、自动保存、风格重写、接受建议并确认 G2', { timeout: 20_000 }, async () => {
    renderScript();

    fireEvent.click(await screen.findByRole('button', { name: /生成口播文案/ }));
    expect(await screen.findByText('黄金 3 秒')).toBeTruthy();

    const firstLines = await screen.findAllByRole('textbox', { name: '第 1 句' });
    const firstLine = firstLines[0]!;
    fireEvent.input(firstLine, {
      target: { textContent: '你有没有这种感觉：学过的东西一用就断片。' },
    });
    await screen.findByText('已自动保存', {}, { timeout: 3000 });

    fireEvent.click(screen.getByRole('button', { name: /生成风格重写/ }));
    const accept = await screen.findAllByRole('button', { name: /接\s*受/ });
    fireEvent.click(accept[0]!);
    await waitFor(() =>
      expect(screen.getByText('说人话就是，你有没有这种感觉：学过的东西一用就断片。')).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole('button', { name: /确认文案/ }));
    fireEvent.click(await screen.findByRole('button', { name: /确认锁定/ }));
    await screen.findByText('视频页');
  });
});
