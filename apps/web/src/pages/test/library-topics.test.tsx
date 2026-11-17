import { createElement } from 'react';
import type { ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import LibraryPage from '../LibraryPage';
import TopicsPage from '../TopicsPage';

function client(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderAt(path: string, element: ReactElement): void {
  render(
    createElement(
      QueryClientProvider,
      { client: client() },
      createElement(
        MemoryRouter,
        { initialEntries: [path] },
        createElement(
          Routes,
          null,
          createElement(Route, { path: '/library', element }),
          createElement(Route, { path: '/discover/topics', element }),
          createElement(Route, {
            path: '/studio/:id/script',
            element: createElement('div', null, '文案编辑器'),
          }),
          createElement(Route, {
            path: '/publish/:id',
            element: createElement('div', null, '派生页'),
          }),
        ),
      ),
    ),
  );
}

afterEach(cleanup);

describe('T-23 素材库最小可用', () => {
  it('读取可见素材，展示来源、授权状态与用户级收藏态', async () => {
    renderAt('/library', createElement(LibraryPage));

    expect(await screen.findByTestId('library-loading')).toBeTruthy();
    expect(await screen.findByText('费曼学习法：用输出倒逼输入')).toBeTruthy();
    expect(screen.getAllByText('已收藏').length).toBeGreaterThan(0);
    expect(screen.getByText('共 10 条可见素材')).toBeTruthy();
  });

  it('携带替换上下文进入素材库，可选择素材后回到派生页', async () => {
    renderAt('/library?work=w1&replace=mat_p2', createElement(LibraryPage));

    expect(await screen.findByText('选择一个同类型素材替换当前阻断素材')).toBeTruthy();
    await screen.findByText('费曼学习法：用输出倒逼输入');
    const replaceButton = screen.getAllByRole('button', { name: /替换为此素材/ })[0];
    if (replaceButton != null) fireEvent.click(replaceButton);

    await waitFor(() => expect(screen.getByText('派生页')).toBeTruthy());
  });
});

describe('T-27 选题页', () => {
  it('读取选题批次，选择角度后进入文案页', { timeout: 15_000 }, async () => {
    renderAt('/discover/topics?materials=mat_k1', createElement(TopicsPage));

    const firstTopic = await screen.findByText('为什么你学了就忘？大脑在骗你');
    expect(firstTopic).toBeTruthy();
    expect(screen.getByText('基于素材 1 条')).toBeTruthy();

    const firstTopicButton = firstTopic.closest('button');
    if (firstTopicButton != null) fireEvent.click(firstTopicButton);
    fireEvent.click(screen.getByRole('button', { name: '生成口播文案' }));

    await waitFor(() => expect(screen.getByText('文案编辑器')).toBeTruthy());
  });
});
