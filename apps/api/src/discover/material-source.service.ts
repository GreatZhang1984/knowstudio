import { Inject, Injectable } from '@nestjs/common';
import {
  ObsidianMcpSourceAdapter,
  RecordedSourceAdapter,
  SourceRegistry,
  StreamableHttpMcpClient,
  TavilySourceAdapter,
} from '@knowstudio/ai';
import type {
  MaterialSource,
  MaterialSourceConfigRequest,
  MaterialSourceConfigResponse,
  MaterialSourceConfigTestResponse,
  MaterialSourceId,
} from '@knowstudio/contracts';
import type { UserSourceConfigRepository, UserSourceConfigRow } from '@knowstudio/db/repositories';
import { buildDevRecordingStores, type DevRecordingStores } from './dev-fixtures.js';
import {
  SOURCE_CONFIG_CIPHER,
  USER_SOURCE_CONFIG_REPOSITORY,
  WEB_SEARCH_ENDPOINT,
} from './source-config.tokens.js';
import type { SourceConfigCipher } from './source-config.crypto.js';

export class MaterialSourceConfigInvalidError extends Error {
  readonly code = 'MATERIAL_SOURCE_CONFIG_INVALID';
  constructor(readonly fields: { path: string; message: string }[]) {
    super('素材源配置校验失败');
    this.name = 'MaterialSourceConfigInvalidError';
  }
}

interface ObsidianSettings {
  endpoint: string;
  tool: string;
  timeoutMs: number;
  maxResults: number;
}

function isLocalOrPrivateEndpoint(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.username !== '' || url.password !== '') return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) {
    return true;
  }
  const parts = host.split('.').map((part) => Number(part));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a === 127 ||
    (a === 169 && b === 254)
  );
}

function rfc3339(value: string | null): string | null {
  return value === null ? null : `${value.replace(' ', 'T')}Z`;
}

@Injectable()
export class MaterialSourceService {
  private devStores: DevRecordingStores | undefined;

  constructor(
    @Inject(USER_SOURCE_CONFIG_REPOSITORY)
    private readonly configs: UserSourceConfigRepository,
    @Inject(SOURCE_CONFIG_CIPHER) private readonly cipher: SourceConfigCipher,
    @Inject(WEB_SEARCH_ENDPOINT) private readonly webSearchEndpoint: string,
  ) {}

  async list(userId: string): Promise<{ items: MaterialSource[] }> {
    const rows = await this.configs.forUser(userId).list();
    const byId = new Map(rows.map((row) => [row.source_id, row]));
    return {
      items: [
        {
          id: 'recorded',
          name: '录制演示',
          description: '内置确定性素材，用于本地与 CI 回归。',
          configured: true,
        },
        {
          id: 'web_search',
          name: 'Web 搜索',
          description:
            byId.get('web_search')?.enabled === 1
              ? 'Tavily 网页搜索，返回真实网页标题、摘要与链接。'
              : '未配置 Tavily API Key。',
          configured: byId.get('web_search')?.enabled === 1,
        },
        {
          id: 'obsidian',
          name: 'Obsidian',
          description:
            byId.get('obsidian')?.enabled === 1
              ? '通过本机或内网 Obsidian MCP 搜索个人笔记。'
              : '未配置 Obsidian MCP 地址与工具名。',
          configured: byId.get('obsidian')?.enabled === 1,
        },
      ],
    };
  }

  async getConfig(userId: string): Promise<MaterialSourceConfigResponse> {
    return this.responseOf(await this.configs.forUser(userId).list());
  }

  async save(
    userId: string,
    request: MaterialSourceConfigRequest,
  ): Promise<MaterialSourceConfigResponse> {
    const repo = this.configs.forUser(userId);
    const existing = new Map((await repo.list()).map((row) => [row.source_id, row]));

    if (request.webSearch !== undefined) {
      const input = request.webSearch;
      const current = existing.get('web_search');
      let ciphertext = current?.credential_ciphertext ?? null;
      let last4 = current?.credential_last4 ?? null;
      if (input.apiKey !== undefined) {
        ciphertext = this.cipher.encrypt(input.apiKey);
        last4 = input.apiKey.slice(-4);
      }
      if (input.enabled && ciphertext === null) {
        throw new MaterialSourceConfigInvalidError([
          { path: 'webSearch.apiKey', message: '首次启用 Web 搜索必须填写 API Key' },
        ]);
      }
      await repo.upsert({
        sourceId: 'web_search',
        enabled: input.enabled,
        settings: { maxResults: input.maxResults },
        credentialCiphertext: input.enabled ? ciphertext : null,
        credentialLast4: input.enabled ? last4 : null,
      });
    }

    if (request.obsidian !== undefined) {
      const input = request.obsidian;
      if (input.enabled && !isLocalOrPrivateEndpoint(input.endpoint)) {
        throw new MaterialSourceConfigInvalidError([
          { path: 'obsidian.endpoint', message: '只允许本机、内网或 .local 地址' },
        ]);
      }
      await repo.upsert({
        sourceId: 'obsidian',
        enabled: input.enabled,
        settings: {
          endpoint: input.endpoint,
          tool: input.tool,
          timeoutMs: input.timeoutMs,
          maxResults: input.maxResults,
        },
        credentialCiphertext: null,
        credentialLast4: null,
      });
    }

    return this.responseOf(await repo.list());
  }

  async remove(userId: string, sourceId: Exclude<MaterialSourceId, 'recorded'>): Promise<void> {
    await this.configs.forUser(userId).delete(sourceId);
  }

  async test(
    userId: string,
    sourceId: Exclude<MaterialSourceId, 'recorded'>,
  ): Promise<MaterialSourceConfigTestResponse> {
    const row = (await this.configs.forUser(userId).list()).find(
      (item) => item.source_id === sourceId,
    );
    if (row?.enabled !== 1) {
      return { sourceId, ok: false, latencyMs: 0, error: '素材源未启用' };
    }
    const adapter = this.adapterOf(row);
    const budget = sourceId === 'obsidian' ? this.obsidianSettings(row).timeoutMs : 8000;
    const startedAt = Date.now();
    const result = await adapter.search(
      { keyword: 'knowstudio connection test', ownerId: userId },
      budget,
    );
    const latencyMs = Date.now() - startedAt;
    const ok = result.status !== 'error';
    if (ok) await this.configs.forUser(userId).markTested(sourceId);
    return {
      sourceId,
      ok,
      latencyMs,
      error: result.error?.message ?? null,
    };
  }

  async registryFor(
    userId: string,
    sourceIds: readonly MaterialSourceId[],
  ): Promise<SourceRegistry> {
    const registry = new SourceRegistry();
    if (sourceIds.includes('recorded')) {
      this.devStores ??= buildDevRecordingStores();
      for (const adapter of [
        new RecordedSourceAdapter('recorded:knowledge', 'knowledge', this.devStores.sourceStore),
        new RecordedSourceAdapter('recorded:hot', 'hot', this.devStores.sourceStore),
        new RecordedSourceAdapter('recorded:peer', 'peer', this.devStores.sourceStore),
      ]) {
        registry.register(adapter);
      }
    }

    const rows = await this.configs.forUser(userId).list();
    for (const sourceId of sourceIds) {
      if (sourceId === 'recorded') continue;
      const row = rows.find((item) => item.source_id === sourceId);
      if (row?.enabled === 1) registry.register(this.adapterOf(row));
    }
    return registry;
  }

  private adapterOf(row: UserSourceConfigRow) {
    if (row.source_id === 'web_search') {
      const maxResults = Number((row.settings as { maxResults?: unknown }).maxResults ?? 5);
      return new TavilySourceAdapter({
        apiKey: this.cipher.decrypt(row.credential_ciphertext ?? ''),
        endpoint: this.webSearchEndpoint,
        maxResults,
      });
    }
    const settings = this.obsidianSettings(row);
    return new ObsidianMcpSourceAdapter({
      client: new StreamableHttpMcpClient({
        endpoint: settings.endpoint,
        timeoutMs: settings.timeoutMs,
      }),
      tool: settings.tool,
      maxResults: settings.maxResults,
    });
  }

  private obsidianSettings(row: UserSourceConfigRow): ObsidianSettings {
    const value = row.settings as Partial<ObsidianSettings>;
    return {
      endpoint: value.endpoint ?? '',
      tool: value.tool ?? '',
      timeoutMs: value.timeoutMs ?? 8000,
      maxResults: value.maxResults ?? 5,
    };
  }

  private responseOf(rows: UserSourceConfigRow[]): MaterialSourceConfigResponse {
    const web = rows.find((row) => row.source_id === 'web_search');
    const obsidian = rows.find((row) => row.source_id === 'obsidian');
    return {
      webSearch: {
        enabled: web?.enabled === 1,
        apiKeyLast4: web?.credential_last4 ?? null,
        maxResults: Number(
          (web?.settings as { maxResults?: unknown } | undefined)?.maxResults ?? 5,
        ),
        testedAt: rfc3339(web?.tested_at ?? null),
        updatedAt: rfc3339(web?.updated_at ?? null),
      },
      obsidian: {
        enabled: obsidian?.enabled === 1,
        endpoint: obsidian === undefined ? null : this.obsidianSettings(obsidian).endpoint,
        tool: obsidian === undefined ? null : this.obsidianSettings(obsidian).tool,
        timeoutMs: obsidian === undefined ? 8000 : this.obsidianSettings(obsidian).timeoutMs,
        maxResults: obsidian === undefined ? 5 : this.obsidianSettings(obsidian).maxResults,
        testedAt: rfc3339(obsidian?.tested_at ?? null),
        updatedAt: rfc3339(obsidian?.updated_at ?? null),
      },
    };
  }
}
