import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import SettingsQuotaPage from '../SettingsQuotaPage';

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

describe('T-49 配额与成本页', () => {
  it('展示同源额度、单价、402 引导和账本明细', async () => {
    render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
        createElement(
          MemoryRouter,
          null,
          createElement(SettingsQuotaPage),
        ),
      ),
    );

    expect(await screen.findByText('配额与成本')).toBeTruthy();
    expect(screen.getByText('已用 22 · 预扣 2 · 剩余 36')).toBeTruthy();
    expect(screen.getByText('草稿渲染 0 点')).toBeTruthy();
    expect(screen.getByText('高清渲染 2 点')).toBeTruthy();
    expect(screen.getAllByText('渲染预扣').length).toBeGreaterThan(0);
    expect(screen.getAllByText('渲染完成').length).toBeGreaterThan(0);
  }, 15_000);
});
