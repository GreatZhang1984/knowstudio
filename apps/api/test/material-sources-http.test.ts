import 'reflect-metadata';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CollectMaterialResponse,
  SearchAccepted,
  SearchSessionSchema,
} from '@knowstudio/contracts';
import { createDiscoverTestApp, type DiscoverTestApp } from './discover-harness.js';

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

async function readBody(request: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of request) body += String(chunk);
  return body;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address == null || typeof address === 'string') throw new Error('测试服务端口获取失败');
  return `http://127.0.0.1:${address.port}`;
}

async function pollSession(t: DiscoverTestApp, token: string, id: string) {
  for (let i = 0; i < 250; i += 1) {
    const response = await fetch(`${t.baseUrl}/api/discover/search/${id}`, {
      headers: auth(token),
    });
    expect(response.status).toBe(200);
    const session = SearchSessionSchema.parse(await response.json());
    if (session.status !== 'queued' && session.status !== 'running') return session;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('真实素材源搜索超时');
}

describe('T-64 Web Search + Obsidian MCP 素材源', () => {
  let t: DiscoverTestApp;
  let tavilyServer: Server;
  let mcpServer: Server;
  const savedIds: string[] = [];
  const oldEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const key of [
      'TAVILY_API_KEY',
      'TAVILY_ENDPOINT',
      'WEB_SEARCH_MAX_RESULTS',
      'MCP_OBSIDIAN_ENABLED',
      'MCP_OBSIDIAN_URL',
      'MCP_OBSIDIAN_TOOL',
      'MCP_OBSIDIAN_MAX_RESULTS',
    ]) {
      oldEnv[key] = process.env[key];
    }

    tavilyServer = createServer((request, response) => {
      void readBody(request).then(() => {
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            results: [
              {
                title: 'AI coding guide',
                url: 'https://example.com/ai-coding',
                content: 'AI coding workflow for developers.',
              },
            ],
          }),
        );
      });
    });
    mcpServer = createServer((request, response) => {
      void readBody(request).then((raw) => {
        const body = JSON.parse(raw) as { id?: number; method: string };
        if (body.method === 'initialize') {
          response.setHeader('content-type', 'application/json');
          response.setHeader('mcp-session-id', 'test-session');
          response.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: body.id,
              result: {
                protocolVersion: '2025-03-26',
                capabilities: {},
                serverInfo: { name: 'obsidian' },
              },
            }),
          );
          return;
        }
        if (body.method === 'notifications/initialized') {
          response.statusCode = 202;
          response.end();
          return;
        }
        response.setHeader('content-type', 'application/json');
        response.setHeader('mcp-session-id', 'test-session');
        response.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    results: [
                      {
                        title: 'AI coding 个人实践',
                        path: 'ai/coding.md',
                        content: '个人笔记里的 AI coding 实践。',
                      },
                    ],
                  }),
                },
              ],
            },
          }),
        );
      });
    });

    const tavilyBase = await listen(tavilyServer);
    const mcpBase = await listen(mcpServer);
    process.env['TAVILY_API_KEY'] = 'test-tavily-key';
    process.env['TAVILY_ENDPOINT'] = `${tavilyBase}/search`;
    process.env['WEB_SEARCH_MAX_RESULTS'] = '5';
    process.env['MCP_OBSIDIAN_ENABLED'] = 'true';
    process.env['MCP_OBSIDIAN_URL'] = `${mcpBase}/mcp`;
    process.env['MCP_OBSIDIAN_TOOL'] = 'search_notes';
    process.env['MCP_OBSIDIAN_MAX_RESULTS'] = '5';
    t = await createDiscoverTestApp();
  }, 60_000);

  afterAll(async () => {
    if (t !== undefined) {
      if (savedIds.length > 0) {
        await t.db.deleteFrom('work_material').where('material_id', 'in', savedIds).execute();
        await t.db.deleteFrom('material').where('id', 'in', savedIds).execute();
      }
      await t.cleanup();
    }
    await new Promise<void>((resolve) => tavilyServer.close(() => resolve()));
    await new Promise<void>((resolve) => mcpServer.close(() => resolve()));
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }, 60_000);

  it('返回可用素材源，并支持 Web + Obsidian 结果落库与收藏', async () => {
    const sourcesResponse = await fetch(`${t.baseUrl}/api/material-sources`, {
      headers: auth(t.tokenA),
    });
    expect(sourcesResponse.status).toBe(200);
    const sources = (await sourcesResponse.json()) as {
      items: { id: string; configured: boolean }[];
    };
    expect(new Map(sources.items.map((item) => [item.id, item.configured]))).toEqual(
      new Map([
        ['recorded', true],
        ['web_search', true],
        ['obsidian', true],
      ]),
    );

    const searchResponse = await fetch(`${t.baseUrl}/api/discover/search`, {
      method: 'POST',
      headers: auth(t.tokenA),
      body: JSON.stringify({
        workId: t.workId,
        keyword: 'AI coding',
        sources: ['web_search', 'obsidian'],
      }),
    });
    expect(searchResponse.status).toBe(202);
    const accepted = SearchAccepted.parse(await searchResponse.json());
    const session = await pollSession(t, t.tokenA, accepted.searchId);

    expect(session.status).toBe('succeeded');
    expect(session.partialErrors).toEqual([
      {
        source: 'llm:blankAngles',
        code: 'BLANK_ANGLES_UNAVAILABLE',
        message: 'NO_RECORDING:blankAngles:ai coding',
      },
    ]);
    expect(session.materials.map((material) => material.source).sort()).toEqual([
      'Obsidian',
      'Web Search',
    ]);
    for (const material of session.materials) {
      expect(material.id.length).toBeLessThanOrEqual(36);
      expect(material.license).toBe('unknown');
      savedIds.push(material.id);
    }

    const rows = await t.db
      .selectFrom('material')
      .select(['id', 'user_id'])
      .where('id', 'in', savedIds)
      .execute();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.user_id === t.seedUserId)).toBe(true);

    const collectResponse = await fetch(`${t.baseUrl}/api/works/${t.workId}/materials`, {
      method: 'POST',
      headers: auth(t.tokenA),
      body: JSON.stringify({ materialId: savedIds[0] }),
    });
    expect(collectResponse.status).toBe(200);
    expect(CollectMaterialResponse.parse(await collectResponse.json()).envelope.gates.G1).toBe(
      true,
    );
  }, 120_000);
});
