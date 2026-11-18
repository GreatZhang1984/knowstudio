#!/usr/bin/env node
/**
 * KnowStudio 本地 Obsidian MCP 桥接服务。
 *
 * 以只读方式扫描本机 Obsidian 库（.md 笔记），通过 MCP Streamable HTTP
 * 暴露 `search_notes` 工具，供 KnowStudio API 的 Obsidian 素材源调用。
 * 不依赖 Obsidian 运行，也不安装任何 Obsidian 插件。
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { Buffer } from 'node:buffer';
import { URL, fileURLToPath } from 'node:url';

const PROTOCOL_VERSION = '2025-03-26';
const SERVER_NAME = 'knowstudio-obsidian-mcp';
const SERVER_VERSION = '0.1.0';
const TOOL_NAME = 'search_notes';
const MAX_BODY_BYTES = 1024 * 1024;
const WALK_DEPTH_LIMIT = 12;

function parseArgs(argv) {
  const options = {
    vault: path.join(
      process.env.USERPROFILE ?? process.env.HOME ?? '',
      'Documents',
      'Obsidian Vault',
    ),
    host: '127.0.0.1',
    port: 3940,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--vault') options.vault = argv[++index];
    else if (arg === '--host') options.host = argv[++index];
    else if (arg === '--port') options.port = Number(argv[++index]);
    else if (arg === '--help' || arg === '-h') {
      console.log('用法: node server.mjs [--vault <库路径>] [--host <地址>] [--port <端口>]');
      process.exit(0);
    }
  }
  options.vault = path.resolve(options.vault);
  if (!Number.isInteger(options.port) || options.port <= 0) {
    throw new Error(`无效端口: ${String(options.port)}`);
  }
  return options;
}

/** 只读笔记索引：按 mtime 增量重读变更文件。 */
class VaultIndex {
  constructor(root) {
    this.root = root;
    this.entries = new Map();
  }

  async assertReadable() {
    const stat = await fs.stat(this.root).catch(() => null);
    if (stat === null || !stat.isDirectory()) {
      throw new Error(`无法读取 Obsidian 库：路径不存在或不是目录（${this.root}）`);
    }
  }

  async refresh() {
    await this.assertReadable();
    const seen = new Set();
    await this.walk(this.root, 0, seen);
    for (const rel of this.entries.keys()) {
      if (!seen.has(rel)) this.entries.delete(rel);
    }
  }

  async walk(dir, depth, seen) {
    if (depth > WALK_DEPTH_LIMIT) return;
    let items;
    try {
      items = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      if (item.name.startsWith('.') || item.name === 'node_modules') continue;
      const full = path.join(dir, item.name);
      if (item.isDirectory()) {
        await this.walk(full, depth + 1, seen);
        continue;
      }
      if (!item.isFile() || !item.name.toLowerCase().endsWith('.md')) continue;
      const rel = path.relative(this.root, full);
      seen.add(rel);
      try {
        const stat = await fs.stat(full);
        const cached = this.entries.get(rel);
        if (cached !== undefined && cached.mtimeMs === stat.mtimeMs) continue;
        const raw = await fs.readFile(full, 'utf8');
        this.entries.set(rel, {
          mtimeMs: stat.mtimeMs,
          title: titleOf(raw, rel),
          text: raw,
        });
      } catch {
        // 单个文件读取失败不影响整体搜索
      }
    }
  }

  search(query, maxResults) {
    const terms = query
      .toLowerCase()
      .split(/\s+/u)
      .filter((term) => term.length > 0);
    const hits = [];
    for (const [rel, entry] of this.entries) {
      if (terms.length === 0) {
        hits.push({ rel, entry, score: 0 });
        continue;
      }
      const title = entry.title.toLowerCase();
      const relLower = rel.toLowerCase();
      const text = entry.text.toLowerCase();
      const matched = terms.every(
        (term) => title.includes(term) || relLower.includes(term) || text.includes(term),
      );
      if (!matched) continue;
      let score = 0;
      for (const term of terms) {
        if (title.includes(term)) score += 10;
        if (relLower.includes(term)) score += 4;
        score += Math.min(occurrences(text, term), 5) * 2;
      }
      hits.push({ rel, entry, score });
    }
    hits.sort((a, b) => b.score - a.score || b.entry.mtimeMs - a.entry.mtimeMs);
    return hits.slice(0, maxResults).map(({ rel, entry }) => ({
      title: entry.title,
      path: rel,
      content: snippetOf(entry.text, terms),
    }));
  }

  get size() {
    return this.entries.size;
  }
}

function titleOf(raw, rel) {
  const heading = /^#\s+(.+)$/mu.exec(raw);
  if (heading !== null) return heading[1].trim();
  return path.basename(rel, path.extname(rel));
}

function occurrences(haystack, term) {
  let count = 0;
  let from = 0;
  while (count < 5) {
    const found = haystack.indexOf(term, from);
    if (found === -1) break;
    count += 1;
    from = found + term.length;
  }
  return count;
}

function snippetOf(raw, terms) {
  const collapsed = raw.replace(/\s+/gu, ' ').trim();
  if (collapsed.length === 0) return '';
  let start = 0;
  const lower = collapsed.toLowerCase();
  for (const term of terms) {
    const found = lower.indexOf(term);
    if (found !== -1) {
      start = Math.max(0, found - 120);
      break;
    }
  }
  const window = collapsed.slice(start, start + 280).trim();
  const prefix = start > 0 ? '…' : '';
  const suffix = start + 280 < collapsed.length ? '…' : '';
  return `${prefix}${window}${suffix}`;
}

function toolSchema() {
  return {
    name: TOOL_NAME,
    description: '搜索本机 Obsidian 库中的 Markdown 笔记，返回标题、路径与内容摘要。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词，支持空格分隔多个词' },
        maxResults: { type: 'number', description: '最大返回条数，1-10，默认 5' },
      },
      required: ['query'],
    },
  };
}

function clampMaxResults(value) {
  const num = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 5;
  return Math.max(1, Math.min(10, num));
}

async function callTool(index, params) {
  const name = typeof params?.name === 'string' ? params.name : '';
  if (name !== TOOL_NAME) {
    throw new Error(`未知工具: ${name || '(空)'}，当前服务仅提供 ${TOOL_NAME}`);
  }
  const args =
    typeof params?.arguments === 'object' && params.arguments !== null ? params.arguments : {};
  const query = typeof args.query === 'string' ? args.query : '';
  const maxResults = clampMaxResults(args.maxResults);
  await index.refresh();
  const results = index.search(query, maxResults);
  return {
    content: [{ type: 'text', text: JSON.stringify({ results }) }],
  };
}

async function handleRpc(index, message) {
  if (typeof message !== 'object' || message === null || typeof message.method !== 'string') {
    return {
      status: 400,
      body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } },
    };
  }
  const { id, method, params } = message;
  if (id === undefined) {
    // 通知类消息按 MCP Streamable HTTP 约定返回 202
    return { status: 202, body: null };
  }
  try {
    if (method === 'initialize') {
      return {
        status: 200,
        body: {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          },
        },
      };
    }
    if (method === 'ping') {
      return { status: 200, body: { jsonrpc: '2.0', id, result: {} } };
    }
    if (method === 'tools/list') {
      return { status: 200, body: { jsonrpc: '2.0', id, result: { tools: [toolSchema()] } } };
    }
    if (method === 'tools/call') {
      const result = await callTool(index, params);
      return { status: 200, body: { jsonrpc: '2.0', id, result } };
    }
    return {
      status: 200,
      body: { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } },
    };
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    return {
      status: 200,
      body: { jsonrpc: '2.0', id, error: { code: -32000, message: messageText } },
    };
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function createServer(options) {
  const index = new VaultIndex(options.vault);
  const sessionId = randomUUID();
  const server = http.createServer(async (req, res) => {
    res.setHeader('mcp-session-id', sessionId);
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '该服务仅支持 MCP POST 调用' }));
      return;
    }
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not Found' }));
      return;
    }
    let message;
    try {
      message = JSON.parse(await readBody(req));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }),
      );
      return;
    }
    const { status, body } = await handleRpc(index, message);
    if (status === 202 || body === null) {
      res.writeHead(202);
      res.end();
      return;
    }
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  return { server, index };
}

const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const options = parseArgs(process.argv.slice(2));
  const { server, index } = createServer(options);
  server.listen(options.port, options.host, () => {
    console.log(`[obsidian-mcp] 库路径: ${options.vault}`);
    console.log(`[obsidian-mcp] MCP 地址: http://${options.host}:${options.port}/mcp`);
    index
      .refresh()
      .then(() => console.log(`[obsidian-mcp] 已索引 ${index.size} 篇笔记`))
      .catch((error) =>
        console.warn(`[obsidian-mcp] ${error instanceof Error ? error.message : String(error)}`),
      );
  });
}
