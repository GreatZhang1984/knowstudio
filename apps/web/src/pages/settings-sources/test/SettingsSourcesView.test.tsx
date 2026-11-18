import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SettingsSourcesView, buildMaterialSourceConfigInput } from '../SettingsSourcesView';

const config = {
  webSearch: {
    enabled: true,
    apiKeyLast4: '1234',
    maxResults: 5,
    testedAt: '2026-11-18T03:00:00.000Z',
    updatedAt: '2026-11-18T03:00:00.000Z',
  },
  obsidian: {
    enabled: false,
    endpoint: null,
    tool: null,
    timeoutMs: 8000,
    maxResults: 5,
    testedAt: null,
    updatedAt: null,
  },
};

describe('T-65 素材源配置页', () => {
  it('展示 Web 与 Obsidian 配置，密钥只显示末四位', () => {
    const markup = renderToStaticMarkup(
      createElement(SettingsSourcesView, {
        config,
        saving: false,
        testingSourceId: null,
        onSave: vi.fn(),
        onTest: vi.fn(),
      }),
    );

    expect(markup).toContain('素材源配置');
    expect(markup).toContain('Web 搜索');
    expect(markup).toContain('****1234');
    expect(markup).toContain('Obsidian MCP');
    expect(markup).toContain('MCP 地址');
    expect(markup).toContain('搜索工具名');
    expect(markup).not.toContain('tvly-test-1234');
  });

  it('Obsidian 未启用且未填写时保存请求省略该源', () => {
    expect(
      buildMaterialSourceConfigInput({
        webEnabled: true,
        apiKey: 'tvly-test-1234',
        webMaxResults: 5,
        obsidianEnabled: false,
        endpoint: '',
        tool: '',
        timeoutMs: 8000,
        obsidianMaxResults: 5,
      }),
    ).toEqual({
      webSearch: {
        enabled: true,
        apiKey: 'tvly-test-1234',
        maxResults: 5,
      },
    });
  });
});
