import 'reflect-metadata';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CollectMaterialResponse,
  MaterialSourceConfigResponse,
  MaterialSourceConfigTestResponse,
  MaterialSourcesResponse,
  SearchAccepted,
  SearchSessionSchema,
} from '@knowstudio/contracts';
import { createDiscoverTestApp, type DiscoverTestApp } from './discover-harness.js';
import { SOURCE_CONFIG_CIPHER, WEB_SEARCH_ENDPOINT } from '../src/discover/discover.tokens.js';

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

const key = randomBytes(32);
const cipher = {
  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const encipher = createCipheriv('aes-256-gcm', key, iv);
    const value = Buffer.concat([encipher.update(plain, 'utf8'), encipher.final()]);
    return [
      'v1',
      iv.toString('base64url'),
      encipher.getAuthTag().toString('base64url'),
      value.toString('base64url'),
    ].join('.');
  },
  decrypt(input: string): string {
    const [version, ivText, tagText, valueText] = input.split('.');
    if (version !== 'v1') throw new Error('SOURCE_CONFIG_CIPHERTEXT_INVALID');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivText ?? '', 'base64url'));
    decipher.setAuthTag(Buffer.from(tagText ?? '', 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(valueText ?? '', 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  },
};

describe('T-65 用户级素材源配置', () => {
  let t: DiscoverTestApp;
  let tavilyServer: Server;
  let mcpServer: Server;
  const savedIds: string[] = [];
  let mcpBase = '';

  beforeAll(async () => {
    tavilyServer = createServer((_request, response) => {
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
              result: { protocolVersion: '2025-03-26', capabilities: {} },
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
    mcpBase = await listen(mcpServer);
    t = await createDiscoverTestApp([
      { provide: SOURCE_CONFIG_CIPHER, useValue: cipher },
      { provide: WEB_SEARCH_ENDPOINT, useValue: `${tavilyBase}/search` },
    ]);
  }, 60_000);

  afterAll(async () => {
    if (t !== undefined) {
      await t.db.deleteFrom('user_source_config').where('user_id', '=', t.seedUserId).execute();
      if (savedIds.length > 0) {
        await t.db.deleteFrom('work_material').where('material_id', 'in', savedIds).execute();
        await t.db.deleteFrom('material').where('id', 'in', savedIds).execute();
      }
      await t.cleanup();
    }
    await new Promise<void>((resolve) => tavilyServer.close(() => resolve()));
    await new Promise<void>((resolve) => mcpServer.close(() => resolve()));
  }, 60_000);

  it('密钥加密保存、配置按用户隔离，并能动态搜索真实源', async () => {
    const denied = await fetch(`${t.baseUrl}/api/material-sources/config`, {
      method: 'PUT',
      headers: auth(t.tokenA),
      body: JSON.stringify({
        obsidian: { enabled: true, endpoint: 'https://example.com/mcp', tool: 'search_notes' },
      }),
    });
    expect(denied.status).toBe(400);

    const saved = await fetch(`${t.baseUrl}/api/material-sources/config`, {
      method: 'PUT',
      headers: auth(t.tokenA),
      body: JSON.stringify({
        webSearch: { enabled: true, apiKey: 'tvly-test-1234', maxResults: 5 },
        obsidian: {
          enabled: true,
          endpoint: `${mcpBase}/mcp`,
          tool: 'search_notes',
          timeoutMs: 8000,
          maxResults: 5,
        },
      }),
    });
    expect(saved.status).toBe(200);
    const savedText = await saved.text();
    expect(savedText).not.toContain('tvly-test-1234');
    const config = MaterialSourceConfigResponse.parse(JSON.parse(savedText));
    expect(config.webSearch.apiKeyLast4).toBe('1234');
    expect(config.obsidian.endpoint).toBe(`${mcpBase}/mcp`);

    const sources = MaterialSourcesResponse.parse(
      await (await fetch(`${t.baseUrl}/api/material-sources`, { headers: auth(t.tokenA) })).json(),
    );
    expect(new Map(sources.items.map((item) => [item.id, item.configured]))).toEqual(
      new Map([
        ['recorded', true],
        ['web_search', true],
        ['obsidian', true],
      ]),
    );
    const otherSources = MaterialSourcesResponse.parse(
      await (await fetch(`${t.baseUrl}/api/material-sources`, { headers: auth(t.tokenB) })).json(),
    );
    expect(otherSources.items.find((item) => item.id === 'web_search')?.configured).toBe(false);

    const stored = await t.db
      .selectFrom('user_source_config')
      .select('credential_ciphertext')
      .where('user_id', '=', t.seedUserId)
      .where('source_id', '=', 'web_search')
      .executeTakeFirstOrThrow();
    expect(stored.credential_ciphertext).not.toContain('tvly-test');

    for (const sourceId of ['web_search', 'obsidian'] as const) {
      const tested = MaterialSourceConfigTestResponse.parse(
        await (
          await fetch(`${t.baseUrl}/api/material-sources/config/test`, {
            method: 'POST',
            headers: auth(t.tokenA),
            body: JSON.stringify({ sourceId }),
          })
        ).json(),
      );
      expect(tested.ok).toBe(true);
    }

    const accepted = SearchAccepted.parse(
      await (
        await fetch(`${t.baseUrl}/api/discover/search`, {
          method: 'POST',
          headers: auth(t.tokenA),
          body: JSON.stringify({
            workId: t.workId,
            keyword: 'AI coding',
            force: true,
            sources: ['web_search', 'obsidian'],
          }),
        })
      ).json(),
    );
    const session = await pollSession(t, t.tokenA, accepted.searchId);
    expect(session.status).toBe('succeeded');
    expect(session.materials.map((material) => material.source).sort()).toEqual([
      'Obsidian',
      'Web Search',
    ]);
    savedIds.push(...session.materials.map((material) => material.id));

    const collect = await fetch(`${t.baseUrl}/api/works/${t.workId}/materials`, {
      method: 'POST',
      headers: auth(t.tokenA),
      body: JSON.stringify({ materialId: savedIds[0] }),
    });
    expect(collect.status).toBe(200);
    expect(CollectMaterialResponse.parse(await collect.json()).envelope.gates.G1).toBe(true);
  }, 120_000);
});
