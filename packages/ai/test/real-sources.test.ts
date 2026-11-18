import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Material } from '@knowstudio/contracts';
import {
  ObsidianMcpSourceAdapter,
  StreamableHttpMcpClient,
  TavilySourceAdapter,
} from '../src/sources/real.js';

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
}

function stableMaterialId(prefix: 'mw_' | 'mo_', identity: string): string {
  return `${prefix}${createHash('sha256').update(identity).digest('hex').slice(0, 33)}`;
}

describe('T-64 Tavily Web Search 适配器', () => {
  it('把真实网页结果映射为可落库素材，同用户同 URL 生成稳定 ID', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({
        results: [
          {
            title: 'AI coding explained',
            url: 'https://example.com/ai-coding',
            content: 'AI coding changes how developers work.',
          },
        ],
      }),
    );
    const adapter = new TavilySourceAdapter({
      apiKey: 'test-key',
      endpoint: 'https://search.example/search',
      fetchImpl,
    });

    const first = await adapter.search({ keyword: 'AI coding', ownerId: 'u1' }, 8_000);
    const second = await adapter.search({ keyword: 'AI coding', ownerId: 'u1' }, 8_000);

    expect(first.status).toBe('ok');
    expect(first.data).toHaveLength(1);
    expect(first.data[0]).toMatchObject({
      id: stableMaterialId('mw_', `u1\0https://example.com/ai-coding`),
      type: 'knowledge',
      title: 'AI coding explained',
      summary: 'AI coding changes how developers work.',
      source: 'Web Search',
      url: 'https://example.com/ai-coding',
      license: 'unknown',
      collected: false,
    } satisfies Partial<Material>);
    expect(second.data[0]?.id).toBe(first.data[0]?.id);

    const [, init] = fetchImpl.mock.calls[0]!;
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer test-key' });
    expect(JSON.parse(String(init?.body))).toEqual({
      query: 'AI coding',
      max_results: 5,
      search_depth: 'basic',
    });
  });

  it('无结果返回 empty，HTTP 失败返回结构化 error', async () => {
    const empty = new TavilySourceAdapter({
      apiKey: 'test-key',
      endpoint: 'https://search.example/search',
      fetchImpl: async () => jsonResponse({ results: [] }),
    });
    expect(await empty.search({ keyword: 'AI coding', ownerId: 'u1' }, 8_000)).toMatchObject({
      status: 'empty',
      data: [],
    });

    const failed = new TavilySourceAdapter({
      apiKey: 'test-key',
      endpoint: 'https://search.example/search',
      fetchImpl: async () => new Response('boom', { status: 502 }),
    });
    expect(await failed.search({ keyword: 'AI coding', ownerId: 'u1' }, 8_000)).toMatchObject({
      status: 'error',
      error: { code: 'WEB_SEARCH_HTTP_502' },
    });
  });
});

describe('T-64 Obsidian MCP 适配器', () => {
  it('把 MCP search 工具返回的笔记映射为个人知识库素材', async () => {
    const callTool = vi.fn(async () => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            results: [
              {
                title: 'AI coding 工作流',
                path: 'projects/ai-coding.md',
                content: '用 AI coding 做测试、重构和发布。',
              },
            ],
          }),
        },
      ],
    }));
    const adapter = new ObsidianMcpSourceAdapter({
      client: { callTool },
      tool: 'search_notes',
      maxResults: 5,
    });

    const result = await adapter.search({ keyword: 'AI coding', ownerId: 'u1' }, 8_000);

    expect(result.status).toBe('ok');
    expect(result.data[0]).toMatchObject({
      id: stableMaterialId('mo_', 'u1\0projects/ai-coding.md\0AI coding 工作流'),
      type: 'knowledge',
      title: 'AI coding 工作流',
      summary: '用 AI coding 做测试、重构和发布。',
      source: 'Obsidian',
      url: null,
      license: 'unknown',
      collected: false,
    } satisfies Partial<Material>);
    expect(callTool).toHaveBeenCalledWith('search_notes', {
      query: 'AI coding',
      maxResults: 5,
    });
  });

  it('纯文本 MCP 结果不会丢失，可作为一条个人笔记素材', async () => {
    const adapter = new ObsidianMcpSourceAdapter({
      client: {
        callTool: async () => ({
          content: [{ type: 'text', text: 'AI coding 的个人实践记录' }],
        }),
      },
      tool: 'search_notes',
    });
    const result = await adapter.search({ keyword: 'AI coding', ownerId: 'u1' }, 8_000);
    expect(result.status).toBe('ok');
    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.summary).toBe('AI coding 的个人实践记录');
  });
});

describe('T-64 Streamable HTTP MCP 客户端', () => {
  it('initialize 建立会话后调用 tools/call', async () => {
    const requests: Array<{ body: unknown; headers: Headers }> = [];
    let call = 0;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      call += 1;
      requests.push({ body: init?.body, headers: new Headers(init?.headers) });
      if (call === 1)
        return jsonResponse(
          {
            jsonrpc: '2.0',
            id: 1,
            result: {
              protocolVersion: '2025-03-26',
              capabilities: {},
              serverInfo: { name: 'obsidian' },
            },
          },
          { headers: { 'mcp-session-id': 'session-1' } },
        );
      if (call === 2) return new Response(null, { status: 202 });
      return jsonResponse({
        jsonrpc: '2.0',
        id: 2,
        result: { content: [{ type: 'text', text: 'ok' }] },
      });
    });
    const client = new StreamableHttpMcpClient({
      endpoint: 'http://127.0.0.1:3940/mcp',
      fetchImpl,
      timeoutMs: 1_000,
    });

    await expect(client.callTool('search_notes', { query: 'AI coding' })).resolves.toEqual({
      content: [{ type: 'text', text: 'ok' }],
    });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(requests[2]?.headers.get('mcp-session-id')).toBe('session-1');
    expect(requests[2]?.body).toBe(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'search_notes', arguments: { query: 'AI coding' } },
      }),
    );
  });
});
