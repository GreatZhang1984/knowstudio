import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import SettingsPage from '../SettingsPage';

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

describe('T-60 指标看板', () => {
  it('展示快照指标，并把缺失口径显示为空值', async () => {
    render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
        createElement(MemoryRouter, null, createElement(SettingsPage)),
      ),
    );

    expect(await screen.findByText('指标看板')).toBeTruthy();
    expect(screen.getByText('G1 端到端 P50')).toBeTruthy();
    expect(screen.getByText('G4 盲测结果需人工录入')).toBeTruthy();
    expect(screen.getByText('42.5 分钟')).toBeTruthy();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  }, 15_000);
});
