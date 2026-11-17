import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import AppLayout from '../src/layout/AppLayout';

(globalThis as { matchMedia?: unknown }).matchMedia = (query: string) => ({
  matches: true,
  media: query,
  onchange: null,
  addListener: () => undefined,
  removeListener: () => undefined,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  dispatchEvent: () => false,
});

afterEach(cleanup);

describe('T-58 渲染等待期并行入口', () => {
  it('高清渲染在途时，全局任务条给出派生编辑入口', async () => {
    render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
        createElement(
          MemoryRouter,
          { initialEntries: ['/'] },
          createElement(
            Routes,
            null,
            createElement(
              Route,
              { path: '/', element: createElement(AppLayout) },
              createElement(Route, { index: true, element: createElement('div', null, '内容') }),
            ),
          ),
        ),
      ),
    );

    const cta = await screen.findByRole('link', { name: '去写平台标题' });
    expect(cta.getAttribute('href')).toBe('/publish/w1');
    expect(screen.getByRole('link', { name: '渲染进度' }).getAttribute('href')).toBe(
      '/studio/w1/render',
    );
  }, 15_000);
});
