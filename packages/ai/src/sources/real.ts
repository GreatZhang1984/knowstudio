import { createHash } from 'node:crypto';
import type { Material } from '@knowstudio/contracts';
import type { PartialResult, SourceAdapter, SourceQuery } from '../ports.js';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function now(): number {
  return Date.now();
}

function hashId(prefix: 'mw_' | 'mo_', identity: string): string {
  return `${prefix}${createHash('sha256').update(identity).digest('hex').slice(0, 33)}`;
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

function number(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function safeUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function obsidianErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message === 'fetch failed'
    ? '无法连接 Obsidian MCP 地址，请确认服务已启动且地址正确'
    : message;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

async function readJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.startsWith('text/event-stream')) {
    const raw = await response.text();
    const data = raw
      .split(/\r?\n/u)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .filter((item) => item.length > 0 && item !== '[DONE]');
    const last = data[data.length - 1];
    return last === undefined ? null : JSON.parse(last);
  }
  return response.json();
}

export interface TavilySourceAdapterOptions {
  readonly apiKey: string;
  readonly endpoint?: string;
  readonly maxResults?: number;
  readonly fetchImpl?: FetchLike;
}

interface TavilyResult {
  readonly title?: unknown;
  readonly url?: unknown;
  readonly content?: unknown;
}

/** Tavily Search API 适配器：网页结果进入素材库，授权一律未知，不做可商用假设。 */
export class TavilySourceAdapter implements SourceAdapter {
  readonly id = 'web:tavily';
  readonly sourceId = 'web_search';
  readonly kind = 'knowledge' as const;
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly maxResults: number;
  private readonly fetchImpl: FetchLike;

  constructor(options: TavilySourceAdapterOptions) {
    this.apiKey = options.apiKey;
    this.endpoint = options.endpoint ?? 'https://api.tavily.com/search';
    this.maxResults = Math.max(1, Math.min(10, Math.floor(number(options.maxResults, 5))));
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  async search(q: SourceQuery, budgetMs: number): Promise<PartialResult<Material[]>> {
    const start = now();
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: q.keyword,
          max_results: this.maxResults,
          search_depth: 'basic',
        }),
        signal: AbortSignal.timeout(Math.max(1, budgetMs)),
      });
      if (!response.ok) {
        return {
          status: 'error',
          data: [],
          error: {
            code: `WEB_SEARCH_HTTP_${response.status}`,
            message: `Web Search HTTP ${response.status}`,
          },
          latencyMs: now() - start,
        };
      }
      const payload = record(await readJson(response));
      const materials = array(payload.results)
        .map((item): TavilyResult => record(item) as TavilyResult)
        .flatMap((item) => {
          const url = safeUrl(item.url);
          const title = text(item.title);
          if (url === null || url.length > 1024 || title === '') return [];
          return [
            {
              id: hashId('mw_', `${q.ownerId ?? 'public'}\0${url}`),
              type: 'knowledge' as const,
              title: clip(title, 500),
              summary: clip(text(item.content), 2_000),
              source: 'Web Search',
              url,
              license: 'unknown' as const,
              collected: false,
            },
          ];
        });
      return materials.length === 0
        ? { status: 'empty', data: [], latencyMs: now() - start }
        : { status: 'ok', data: materials, latencyMs: now() - start };
    } catch (error) {
      return {
        status: 'error',
        data: [],
        error: {
          code:
            error instanceof Error && error.name === 'TimeoutError'
              ? 'WEB_SEARCH_TIMEOUT'
              : 'WEB_SEARCH_FAILED',
          message: error instanceof Error ? error.message : String(error),
        },
        latencyMs: now() - start,
      };
    }
  }
}

export interface McpToolClient {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface StreamableHttpMcpClientOptions {
  readonly endpoint: string;
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
}

interface JsonRpcResponse {
  readonly jsonrpc?: string;
  readonly id?: unknown;
  readonly result?: unknown;
  readonly error?: { message?: string };
}

/** MCP Streamable HTTP 最小客户端：initialize、initialized 通知与 tools/call。 */
export class StreamableHttpMcpClient implements McpToolClient {
  private sessionId: string | null = null;
  private nextId = 1;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly options: StreamableHttpMcpClientOptions) {
    this.timeoutMs = Math.max(1, Math.floor(number(options.timeoutMs, 8_000)));
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.ensureInitialized();
    return (
      (
        await this.request({
          jsonrpc: '2.0',
          id: this.nextId++,
          method: 'tools/call',
          params: { name, arguments: args },
        })
      ).result ?? null
    );
  }

  private async ensureInitialized(): Promise<void> {
    if (this.sessionId !== null) return;
    await this.request({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'knowstudio', version: '0.1.0' },
      },
    });
    await this.request({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
  }

  private async request(body: Record<string, unknown>): Promise<JsonRpcResponse> {
    const headers = new Headers({
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    });
    const sessionHeader = this.sessionId;
    if (sessionHeader !== null) headers.set('mcp-session-id', sessionHeader);
    const response = await this.fetchImpl(this.options.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`MCP_HTTP_${response.status}`);
    const sessionId = response.headers.get('mcp-session-id');
    if (sessionId !== null) this.sessionId = sessionId;
    if (response.status === 202) return {};
    const payload = record(await readJson(response));
    const error = (payload as JsonRpcResponse).error;
    if (error !== undefined) throw new Error(error.message ?? 'MCP_ERROR');
    return payload as JsonRpcResponse;
  }
}

export interface ObsidianMcpSourceAdapterOptions {
  readonly client: McpToolClient;
  readonly tool: string;
  readonly maxResults?: number;
}

interface ObsidianNote {
  readonly title?: unknown;
  readonly path?: unknown;
  readonly content?: unknown;
  readonly snippet?: unknown;
  readonly text?: unknown;
  readonly url?: unknown;
}

/** Obsidian MCP 适配器：个人笔记作为素材返回，授权先保持未知，由合规链路处理。 */
export class ObsidianMcpSourceAdapter implements SourceAdapter {
  readonly id = 'mcp:obsidian';
  readonly sourceId = 'obsidian';
  readonly kind = 'knowledge' as const;
  private readonly maxResults: number;

  constructor(private readonly options: ObsidianMcpSourceAdapterOptions) {
    this.maxResults = Math.max(1, Math.min(10, Math.floor(number(options.maxResults, 5))));
  }

  async search(q: SourceQuery, _budgetMs: number): Promise<PartialResult<Material[]>> {
    const start = now();
    try {
      const result = await this.options.client.callTool(this.options.tool, {
        query: q.keyword,
        maxResults: this.maxResults,
      });
      const materials = this.materialsOf(result, q);
      return materials.length === 0
        ? { status: 'empty', data: [], latencyMs: now() - start }
        : { status: 'ok', data: materials, latencyMs: now() - start };
    } catch (error) {
      return {
        status: 'error',
        data: [],
        error: {
          code:
            error instanceof Error && error.message.startsWith('MCP_')
              ? error.message
              : 'OBSIDIAN_MCP_FAILED',
          message: obsidianErrorMessage(error),
        },
        latencyMs: now() - start,
      };
    }
  }

  private materialsOf(result: unknown, q: SourceQuery): Material[] {
    const root = record(result);
    let candidates: unknown[] = array(root.results ?? root.notes ?? root.items);
    let plainText = '';
    if (candidates.length === 0 && Array.isArray(root.content)) {
      const texts = array(root.content)
        .map((item) => text(record(item).text))
        .filter((item) => item.length > 0);
      const joined = texts.join('\n');
      try {
        const parsed = JSON.parse(joined) as unknown;
        candidates = array(record(parsed).results ?? record(parsed).notes ?? record(parsed).items);
      } catch {
        plainText = joined;
      }
    }
    if (candidates.length === 0 && plainText !== '') {
      return [
        {
          id: hashId('mo_', `${q.ownerId ?? 'public'}\0${plainText}`),
          type: 'knowledge',
          title: clip(`${q.keyword} · Obsidian 笔记`, 500),
          summary: clip(plainText, 2_000),
          source: 'Obsidian',
          url: null,
          license: 'unknown',
          collected: false,
        },
      ];
    }

    return candidates.slice(0, this.maxResults).flatMap((item) => {
      const note = record(item) as ObsidianNote;
      const title = text(note.title, text(note.path));
      const path = text(note.path, title);
      const summary = text(note.content, text(note.snippet, text(note.text)));
      if (title === '' || summary === '') return [];
      return [
        {
          id: hashId('mo_', `${q.ownerId ?? 'public'}\0${path}\0${title}`),
          type: 'knowledge' as const,
          title: clip(title, 500),
          summary: clip(summary, 2_000),
          source: 'Obsidian',
          url: safeUrl(note.url),
          license: 'unknown' as const,
          collected: false,
        },
      ];
    });
  }
}
