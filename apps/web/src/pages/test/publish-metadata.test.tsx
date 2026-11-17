import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import PublishPage from '../PublishPage';

(globalThis as { matchMedia?: unknown }).matchMedia = (query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => undefined,
  removeListener: () => undefined,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  dispatchEvent: () => false,
});

afterEach(cleanup);

function renderPublish(path: string): void {
  render(
    createElement(
      QueryClientProvider,
      { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
      createElement(
        MemoryRouter,
        { initialEntries: [path] },
        createElement(
          Routes,
          null,
          createElement(Route, { path: '/publish/:id', element: createElement(PublishPage) }),
        ),
      ),
    ),
  );
}

describe('T-51/T-53/T-58 元数据派生闭环', () => {
  it('生成四平台元数据；单平台修改互不影响；标题可重生成', async () => {
    renderPublish('/publish/w1');

    fireEvent.click(
      await screen.findByRole('button', { name: '生成四平台元数据' }, { timeout: 5000 }),
    );
    expect(await screen.findByText('现在可以先编辑标题和标签')).toBeTruthy();
    expect((await screen.findAllByText('抖音')).length).toBeGreaterThan(0);
    expect(screen.getByText('B站')).toBeTruthy();
    expect(screen.getByText('视频号')).toBeTruthy();
    expect(screen.getByText('小红书')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /B站/ }));
    fireEvent.change(screen.getByLabelText('标题'), {
      target: { value: 'B站专属：把费曼学习法讲成一套复习流程' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存当前平台' }));
    expect(
      await screen.findByDisplayValue('B站专属：把费曼学习法讲成一套复习流程'),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /抖音/ }));
    expect(screen.getByDisplayValue('别再死记硬背了')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /小红书/ }));
    fireEvent.click(screen.getByRole('button', { name: '重新生成标题' }));
    expect(await screen.findByDisplayValue(/升级版/)).toBeTruthy();
  }, 15_000);

  it('高清完成后可生成平台媒体，并在当前平台展示预览', async () => {
    renderPublish('/publish/w3');
    fireEvent.click(await screen.findByRole('button', { name: '生成四平台元数据' }));
    fireEvent.click(await screen.findByRole('button', { name: '生成平台媒体版本' }));
    expect(await screen.findByText('平台成片已生成')).toBeTruthy();
    expect(screen.getByText(/平台媒体派生/)).toBeTruthy();
    expect(document.querySelector('video')?.getAttribute('src')).toBe('/fixture-video.mp4');
  }, 15_000);
});
