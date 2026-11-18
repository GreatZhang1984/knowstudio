import {
  ObsidianMcpSourceAdapter,
  RecordedSourceAdapter,
  SourceRegistry,
  StreamableHttpMcpClient,
  TavilySourceAdapter,
} from '@knowstudio/ai';
import type { MaterialSource } from '@knowstudio/contracts';
import { buildDevRecordingStores, type DevRecordingStores } from './dev-fixtures.js';

export interface MaterialSourceRuntime {
  readonly registry: SourceRegistry;
  readonly sources: readonly MaterialSource[];
}

function envInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

let devStores: DevRecordingStores | undefined;
let runtime: MaterialSourceRuntime | undefined;

/**
 * T-64 素材源组合根：录制源用于 dev/CI 回归；Tavily 与 Obsidian MCP 由服务端环境配置启用。
 * 前端只选择服务端已声明的 source id，不接收任意外部 URL，避免把凭据或 SSRF 面暴露到浏览器。
 */
export function materialSourceRuntime(): MaterialSourceRuntime {
  runtime ??= buildRuntime();
  return runtime;
}

function buildRuntime(): MaterialSourceRuntime {
  devStores ??= buildDevRecordingStores();
  const registry = new SourceRegistry();
  const sources: MaterialSource[] = [
    {
      id: 'recorded',
      name: '录制演示',
      description: '内置确定性素材，用于本地与 CI 回归。',
      configured: true,
    },
  ];
  for (const adapter of [
    new RecordedSourceAdapter('recorded:knowledge', 'knowledge', devStores.sourceStore),
    new RecordedSourceAdapter('recorded:hot', 'hot', devStores.sourceStore),
    new RecordedSourceAdapter('recorded:peer', 'peer', devStores.sourceStore),
  ]) {
    registry.register(adapter);
  }

  const tavilyKey = process.env['TAVILY_API_KEY'];
  if (tavilyKey !== undefined && tavilyKey !== '') {
    registry.register(
      new TavilySourceAdapter({
        apiKey: tavilyKey,
        endpoint: process.env['TAVILY_ENDPOINT'],
        maxResults: envInt('WEB_SEARCH_MAX_RESULTS', 5),
      }),
    );
    sources.push({
      id: 'web_search',
      name: 'Web 搜索',
      description: 'Tavily 网页搜索，返回真实网页标题、摘要与链接。',
      configured: true,
    });
  } else {
    sources.push({
      id: 'web_search',
      name: 'Web 搜索',
      description: '未配置 TAVILY_API_KEY。',
      configured: false,
    });
  }

  const mcpUrl = process.env['MCP_OBSIDIAN_URL'];
  const mcpTool = process.env['MCP_OBSIDIAN_TOOL'];
  if (
    process.env['MCP_OBSIDIAN_ENABLED'] === 'true' &&
    mcpUrl !== undefined &&
    mcpUrl !== '' &&
    mcpTool !== undefined &&
    mcpTool !== ''
  ) {
    registry.register(
      new ObsidianMcpSourceAdapter({
        client: new StreamableHttpMcpClient({
          endpoint: mcpUrl,
          timeoutMs: envInt('MCP_OBSIDIAN_TIMEOUT_MS', 8_000),
        }),
        tool: mcpTool,
        maxResults: envInt('MCP_OBSIDIAN_MAX_RESULTS', 5),
      }),
    );
    sources.push({
      id: 'obsidian',
      name: 'Obsidian',
      description: '通过本机或内网 Obsidian MCP 搜索个人笔记。',
      configured: true,
    });
  } else {
    sources.push({
      id: 'obsidian',
      name: 'Obsidian',
      description: '未同时配置 MCP_OBSIDIAN_ENABLED、MCP_OBSIDIAN_URL 与 MCP_OBSIDIAN_TOOL。',
      configured: false,
    });
  }

  return { registry, sources };
}
