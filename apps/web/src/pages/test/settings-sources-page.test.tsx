import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SettingsSourcesPage from '../SettingsSourcesPage';

vi.mock('../../work/api', () => ({
  fetchMaterialSourceConfig: vi.fn().mockRejectedValue({
    apiError: {
      code: 'UNAUTHENTICATED',
      message: '未认证或会话已失效',
      details: { loginUrl: '/login' },
    },
  }),
  testMaterialSource: vi.fn(),
  updateMaterialSourceConfig: vi.fn(),
}));

afterEach(cleanup);

describe('素材源配置页认证错误', () => {
  it('会话失效时提供重新登录并带回当前页面', async () => {
    render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
        createElement(
          MemoryRouter,
          { initialEntries: ['/settings/sources'] },
          createElement(
            Routes,
            null,
            createElement(Route, {
              path: '/settings/sources',
              element: createElement(SettingsSourcesPage),
            }),
          ),
        ),
      ),
    );

    expect(await screen.findByText('登录状态已过期')).toBeTruthy();
    expect(screen.getByRole('link', { name: '重新登录' }).getAttribute('href')).toBe(
      '/login?returnTo=%2Fsettings%2Fsources',
    );
  }, 15_000);
});
