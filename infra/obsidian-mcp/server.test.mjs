import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from './server.mjs';

const fetch = globalThis.fetch.bind(globalThis);

let vault;
let server;
let endpoint;

async function rpc(body, sessionId) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (sessionId !== undefined) headers['mcp-session-id'] = sessionId;
  const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await response.text();
  return {
    status: response.status,
    sessionId: response.headers.get('mcp-session-id'),
    body: text === '' ? null : JSON.parse(text),
  };
}

async function callSearch(query, maxResults = 5) {
  const init = await rpc({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
  });
  assert.equal(init.status, 200);
  await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, init.sessionId);
  const call = await rpc(
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'search_notes', arguments: { query, maxResults } },
    },
    init.sessionId,
  );
  assert.equal(call.status, 200);
  return call.body;
}

function resultsOf(rpcBody) {
  assert.equal(rpcBody.error, undefined);
  const text = rpcBody.result.content[0].text;
  return JSON.parse(text).results;
}

before(async () => {
  vault = await fs.mkdtemp(path.join(os.tmpdir(), 'obsidian-mcp-test-'));
  await fs.mkdir(path.join(vault, '编程'), { recursive: true });
  await fs.writeFile(
    path.join(vault, '编程', 'AI Coding 实践.md'),
    '# AI Coding 实践\n\nAI coding 工具对比：Copilot、Cursor 与 Claude Code 的协作方式。\n',
  );
  await fs.writeFile(
    path.join(vault, '烹饪笔记.md'),
    '# 红烧肉\n\n五花肉切块焯水，冰糖炒色。\n',
  );
  await fs.mkdir(path.join(vault, '.obsidian'), { recursive: true });
  await fs.writeFile(path.join(vault, '.obsidian', 'workspace.md'), '不应被索引');

  const created = createServer({ vault });
  server = created.server;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  endpoint = `http://127.0.0.1:${server.address().port}/mcp`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(vault, { recursive: true, force: true });
});

test('initialize 返回 serverInfo 与会话头', async () => {
  const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(init.body.result.serverInfo.name, 'knowstudio-obsidian-mcp');
  assert.ok(init.sessionId);
});

test('notifications/initialized 返回 202', async () => {
  const res = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(res.status, 202);
});

test('search_notes 命中多词查询并跳过隐藏目录', async () => {
  const results = resultsOf(await callSearch('AI Coding'));
  assert.equal(results.length, 1);
  assert.equal(results[0].title, 'AI Coding 实践');
  assert.equal(results[0].path, path.join('编程', 'AI Coding 实践.md'));
  assert.match(results[0].content, /Copilot/u);
});

test('search_notes 未命中返回空列表', async () => {
  const results = resultsOf(await callSearch('不存在的词'));
  assert.deepEqual(results, []);
});

test('空查询按修改时间返回最近笔记', async () => {
  const results = resultsOf(await callSearch('', 10));
  assert.equal(results.length, 2);
});

test('未知工具返回 JSON-RPC 错误', async () => {
  const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  const call = await rpc(
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'noop', arguments: {} } },
    init.sessionId,
  );
  assert.match(call.body.error.message, /未知工具/u);
});

test('库路径不存在时返回可读错误', async () => {
  const missing = createServer({ vault: path.join(vault, '不存在') });
  await new Promise((resolve) => missing.server.listen(0, '127.0.0.1', resolve));
  const port = missing.server.address().port;
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'search_notes', arguments: { query: 'x' } },
    }),
  });
  const body = await response.json();
  assert.match(body.error.message, /无法读取 Obsidian 库/u);
  await new Promise((resolve) => missing.server.close(resolve));
});
