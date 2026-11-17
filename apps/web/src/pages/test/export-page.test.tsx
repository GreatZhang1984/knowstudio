import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { G5_EXPORT_NOTICE } from '@knowstudio/ui';
import ExportPage from '../ExportPage';

afterEach(cleanup);

function renderExport(): void {
  render(
    createElement(
      QueryClientProvider,
      { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
      createElement(
        MemoryRouter,
        { initialEntries: ['/publish/w3/export'] },
        createElement(
          Routes,
          null,
          createElement(Route, {
            path: '/publish/:id/export',
            element: createElement(ExportPage),
          }),
        ),
      ),
    ),
  );
}

describe('T-56/T-57 导出页闭环', () => {
  it('合规阻断时列出问题与修复入口，不进入打包', async () => {
    renderExport();
    fireEvent.click(await screen.findByRole('button', { name: '开始导出打包' }));

    expect(await screen.findByText('导出被合规阻断')).toBeTruthy();
    expect(await screen.findByText('文案与平台内容')).toBeTruthy();
    expect(screen.getByRole('link', { name: '去修复合规' }).getAttribute('href')).toBe(
      '/publish/w3',
    );
    expect(screen.getByRole('link', { name: /替换 mat_h1/ }).getAttribute('href')).toContain(
      'replace=mat_h1',
    );
  }, 15_000);

  it('合规通过后轮询打包，并展示 ZIP、清单和四平台产物', async () => {
    const { attachFixtureMaterialLicense } = await import('../../work/fixtures');
    attachFixtureMaterialLicense('w3', 'mat_k1', {
      evidenceUrl: 'https://licenses.example.invalid/k1.pdf',
    });
    attachFixtureMaterialLicense('w3', 'mat_h1', {
      evidenceUrl: 'https://licenses.example.invalid/h1.pdf',
    });
    renderExport();
    fireEvent.click(await screen.findByRole('button', { name: '开始导出打包' }));

    expect(await screen.findByText('导出完成', undefined, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByText(G5_EXPORT_NOTICE)).toBeTruthy();
    expect(screen.getByText('下载 ZIP 包').closest('a')?.getAttribute('href')).toContain(
      '/package.zip',
    );
    expect(screen.getByText('manifest.json').closest('a')?.getAttribute('href')).toContain(
      'manifest.json',
    );
    expect(screen.getByText('发布清单.md').closest('a')?.getAttribute('href')).toContain(
      'publish-checklist.md',
    );
    expect(screen.getAllByText('下载成片')).toHaveLength(4);
    expect(screen.getAllByText('下载封面')).toHaveLength(4);
  }, 15_000);
});
