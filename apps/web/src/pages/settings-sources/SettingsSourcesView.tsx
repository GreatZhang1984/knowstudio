import { useEffect, useState } from 'react';
import { Alert, Button, Input, InputNumber, Switch, Tag } from 'antd';
import type {
  ExternalMaterialSourceId,
  MaterialSourceConfigRequest,
  MaterialSourceConfigResponse,
} from '@knowstudio/contracts';

export interface SettingsSourcesViewProps {
  readonly config: MaterialSourceConfigResponse;
  readonly saving: boolean;
  readonly testingSourceId: ExternalMaterialSourceId | null;
  readonly onSave: (input: MaterialSourceConfigRequest) => void;
  readonly onTest: (sourceId: ExternalMaterialSourceId) => void;
}

function formatTime(value: string | null): string {
  return value === null ? '未测试' : new Date(value).toLocaleString();
}

export function buildMaterialSourceConfigInput(input: {
  readonly webEnabled: boolean;
  readonly apiKey: string;
  readonly webMaxResults: number;
  readonly obsidianEnabled: boolean;
  readonly endpoint: string;
  readonly tool: string;
  readonly timeoutMs: number;
  readonly obsidianMaxResults: number;
}): MaterialSourceConfigRequest {
  const hasObsidianFields = input.obsidianEnabled || input.endpoint !== '' || input.tool !== '';
  return {
    webSearch: {
      enabled: input.webEnabled,
      ...(input.apiKey === '' ? {} : { apiKey: input.apiKey }),
      maxResults: input.webMaxResults,
    },
    ...(hasObsidianFields
      ? {
          obsidian: {
            enabled: input.obsidianEnabled,
            endpoint: input.endpoint,
            tool: input.tool,
            timeoutMs: input.timeoutMs,
            maxResults: input.obsidianMaxResults,
          },
        }
      : {}),
  };
}

export function SettingsSourcesView(props: SettingsSourcesViewProps) {
  const { config, saving, testingSourceId, onSave, onTest } = props;
  const [webEnabled, setWebEnabled] = useState(config.webSearch.enabled);
  const [apiKey, setApiKey] = useState('');
  const [webMaxResults, setWebMaxResults] = useState(config.webSearch.maxResults);
  const [obsidianEnabled, setObsidianEnabled] = useState(config.obsidian.enabled);
  const [endpoint, setEndpoint] = useState(config.obsidian.endpoint ?? '');
  const [tool, setTool] = useState(config.obsidian.tool ?? '');
  const [timeoutMs, setTimeoutMs] = useState(config.obsidian.timeoutMs);
  const [obsidianMaxResults, setObsidianMaxResults] = useState(config.obsidian.maxResults);

  useEffect(() => {
    setWebEnabled(config.webSearch.enabled);
    setWebMaxResults(config.webSearch.maxResults);
    setObsidianEnabled(config.obsidian.enabled);
    setEndpoint(config.obsidian.endpoint ?? '');
    setTool(config.obsidian.tool ?? '');
    setTimeoutMs(config.obsidian.timeoutMs);
    setObsidianMaxResults(config.obsidian.maxResults);
    setApiKey('');
  }, [config]);

  return (
    <section className="source-settings-page">
      <header className="discover-head">
        <div>
          <h1>素材源配置</h1>
          <p>配置按当前登录用户保存，API Key 只保存加密密文。</p>
        </div>
        <Button
          type="primary"
          loading={saving}
          onClick={() =>
            onSave(
              buildMaterialSourceConfigInput({
                webEnabled,
                apiKey,
                webMaxResults,
                obsidianEnabled,
                endpoint,
                tool,
                timeoutMs,
                obsidianMaxResults,
              }),
            )
          }
        >
          保存配置
        </Button>
      </header>

      <section className="source-settings-panel">
        <header>
          <h2>Web 搜索</h2>
          <Switch checked={webEnabled} onChange={setWebEnabled} aria-label="启用 Web 搜索" />
        </header>
        <p>
          密钥：
          {config.webSearch.apiKeyLast4 === null ? (
            '未保存'
          ) : (
            <Tag>****{config.webSearch.apiKeyLast4}</Tag>
          )}
          <span>上次测试：{formatTime(config.webSearch.testedAt)}</span>
        </p>
        <label>
          Tavily API Key
          <Input.Password
            value={apiKey}
            aria-label="Tavily API Key"
            placeholder="留空则保留已保存密钥"
            onChange={(event) => setApiKey(event.target.value)}
          />
        </label>
        <label>
          最大结果数
          <InputNumber
            min={1}
            max={10}
            value={webMaxResults}
            aria-label="Web 最大结果数"
            onChange={(value) => setWebMaxResults(value ?? 5)}
          />
        </label>
        <Button
          disabled={!webEnabled || config.webSearch.apiKeyLast4 === null}
          loading={testingSourceId === 'web_search'}
          onClick={() => onTest('web_search')}
        >
          测试连接
        </Button>
      </section>

      <section className="source-settings-panel">
        <header>
          <h2>Obsidian MCP</h2>
          <Switch
            checked={obsidianEnabled}
            onChange={setObsidianEnabled}
            aria-label="启用 Obsidian"
          />
        </header>
        <p>上次测试：{formatTime(config.obsidian.testedAt)}</p>
        <label>
          MCP 地址
          <Input
            value={endpoint}
            aria-label="MCP 地址"
            placeholder="http://127.0.0.1:3940/mcp"
            onChange={(event) => setEndpoint(event.target.value)}
          />
        </label>
        <label>
          搜索工具名
          <Input
            value={tool}
            aria-label="搜索工具名"
            placeholder="search_notes"
            onChange={(event) => setTool(event.target.value)}
          />
        </label>
        <div className="source-settings-panel__numbers">
          <label>
            超时毫秒
            <InputNumber
              min={1000}
              max={30000}
              step={500}
              value={timeoutMs}
              aria-label="MCP 超时毫秒"
              onChange={(value) => setTimeoutMs(value ?? 8000)}
            />
          </label>
          <label>
            最大结果数
            <InputNumber
              min={1}
              max={10}
              value={obsidianMaxResults}
              aria-label="Obsidian 最大结果数"
              onChange={(value) => setObsidianMaxResults(value ?? 5)}
            />
          </label>
        </div>
        <Button
          disabled={!obsidianEnabled || endpoint.trim() === '' || tool.trim() === ''}
          loading={testingSourceId === 'obsidian'}
          onClick={() => onTest('obsidian')}
        >
          测试连接
        </Button>
        <Alert type="info" showIcon message="仅支持本机、内网和 .local MCP 地址" />
      </section>
    </section>
  );
}
