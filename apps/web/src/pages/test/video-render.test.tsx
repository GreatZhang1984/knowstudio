import { createElement } from 'react';
import type { ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import RenderPage from '../RenderPage';
import VideoPage from '../VideoPage';

afterEach(cleanup);

function renderAt(path: string, element: ReactElement): ReturnType<typeof render> {
  return render(
    createElement(
      QueryClientProvider,
      { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
      createElement(
        MemoryRouter,
        { initialEntries: [path] },
        createElement(
          Routes,
          null,
          createElement(Route, { path: '/studio/:id/video', element }),
          createElement(Route, { path: '/studio/:id/render', element: createElement(RenderPage) }),
          createElement(Route, {
            path: '/studio/:id/script',
            element: createElement('div', null, '文案页'),
          }),
        ),
      ),
    ),
  );
}

describe('T-35～T-48 视频与渲染中心', () => {
  it('生成草稿后展示可播放视频，渲染中心可恢复任务', async () => {
    const view = renderAt('/studio/w1/video', createElement(VideoPage));
    fireEvent.click(await screen.findByRole('button', { name: /生成 480p 草稿/ }));
    await screen.findByText('生成 1080p 高清 · 2 点');
    const video = view.container.querySelector('video');
    expect(video?.getAttribute('src')).toBe('/fixture-video.mp4');

    expect(screen.getByRole('link', { name: /渲染中心/ }).getAttribute('href')).toBe(
      '/studio/w1/render?job=job_draft_w1',
    );
    cleanup();
    renderAt('/studio/w1/render?job=job_draft_w1', createElement(RenderPage));
    expect((await screen.findAllByText('succeeded')).length).toBeGreaterThan(0);
  }, 15_000);
});
