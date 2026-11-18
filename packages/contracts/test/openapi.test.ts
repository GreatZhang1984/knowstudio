import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  G5_FORBIDDEN_ROUTE_PATTERN,
  PublishRouteViolationError,
  REGISTERED_ROUTES,
  assertNoPublishRoutes,
  buildOpenApiDocument,
  type OpenApiDocument,
} from '../src/openapi.js';
import { DB_ENUMS } from '../src/enums.js';
import { CreateStyleSampleRequest, StyleSampleSchema } from '../src/api.js';

const SNAPSHOT_PATH = fileURLToPath(new URL('../openapi.json', import.meta.url));
const WRITE_METHODS = ['post', 'put', 'patch', 'delete'] as const;

/**
 * 逐条抄录 SPEC §5 接口表（第 551–563 行）中属于 P0 的路由。
 * 抄录而非从实现反推，否则「实现覆盖了什么」就成了验收标准本身。
 * 排除项：SPEC 明写 P1 的 `script:derive`；SPEC §1.5 划为 P1 的 trends / onboarding /
 * PATCH me / 素材库写与详情 / **风格样本删除与管理页**；架构 §10.3 定为内部接口的
 * quota:reserve|:release。
 *
 * 注意风格样本的切分口径：SPEC §1.5 spec:81「风格样本管理」指的是**管理页与删除**
 * （§2.5 spec:190 标 P1、plan S-M2-6 plan:66），**不含创建**。`POST /style-samples` 是 P0：
 * SPEC §3.4 spec:319「P0 需支持 ≥3 篇」+ §5 spec:562 列出该路由 + plan T-32 plan:143
 * 落在 S4（M1）+ §12.2 step 9 plan:533 由 T-61 全剧本跑。故它在本清单内，而
 * `DELETE /style-samples/{id}` 在下方禁入清单内。
 */
const SPEC_P0_ROUTES = [
  'POST /works',
  'GET /works',
  'GET /works/{id}',
  'PATCH /works/{id}',
  'DELETE /works/{id}',
  'POST /discover/search',
  'GET /discover/search/{id}',
  'POST /works/{id}/materials',
  'DELETE /works/{id}/materials/{mid}',
  'POST /works/{id}/topics:generate',
  'GET /works/{id}/topics',
  'POST /works/{id}/topics:reroll',
  'POST /works/{id}/topic:select',
  'POST /works/{id}/script:generate',
  'PATCH /works/{id}/script',
  'POST /works/{id}/script:restyle',
  'POST /works/{id}/script/hunks/{hid}:accept',
  'POST /works/{id}/script/hunks/{hid}:reject',
  'POST /works/{id}/script:confirm',
  'POST /works/{id}/script:unlock',
  'POST /works/{id}/video:draft',
  'POST /works/{id}/video:render',
  'PATCH /works/{id}/video',
  'POST /works/{id}/video:patch',
  'GET /jobs/{id}',
  'GET /jobs/{id}/events',
  'POST /jobs/{id}:cancel',
  'POST /jobs/{id}:retry',
  'POST /works/{id}/derivatives:generate',
  'PATCH /works/{id}/derivatives/{platformId}',
  'POST /works/{id}/derivatives/{platformId}/title:regenerate',
  'GET /platform-rules',
  'GET /works/{id}/compliance',
  'POST /works/{id}/export',
  'GET /exports/{id}',
  'GET /library',
  'GET /quota',
  'GET /quota/ledger',
  'GET /style-samples',
  'POST /style-samples',
  'GET /style-profile',
  'POST /auth/login',
  'POST /auth/logout',
  'GET /me',
] as const;

/**
 * 超出 SPEC §5 的三条路由，逐条给出依据。新增任何一条都必须先在此登记，
 * 否则上一条测试会失败——防止契约悄悄长出需求里没有的接口。
 * 后两条是**待产品确认的缺口**：SPEC §5 只给了 PATCH script / PATCH derivatives，
 * 但编辑器与派生页刷新后必须能读回内容，而 GET /works/:id 信封不含 lines/派生正文。
 */
const DECLARED_EXTRA_ROUTES = [
  'POST /auth/refresh', // 架构 §10.1：accessToken 15min，/auth/refresh 用 HttpOnly Cookie
  'GET /works/{id}/script', // SPEC 缺口：§3.4 编辑器需要读回 lines
  'GET /works/{id}/derivatives', // SPEC 缺口：§3.6 派生页需要读回四平台内容
  'POST /works/{id}/materials/{mid}/replace', // T-55：合规阻断需要真实替换当前作品素材
  'POST /works/{id}/materials/{mid}/license', // T-55：合规阻断修复需要绑定授权凭证并立即复检
  'POST /events', // T-59：仅 script_first_edit / publish_receipt_marked 客户端事件
  'GET /material-sources', // T-64：工作台选择录制源 / Web 搜索 / Obsidian MCP
  'GET /material-sources/config', // T-65：用户级素材源配置，不使用进程环境变量
  'PUT /material-sources/config', // T-65：保存加密 API Key 与非敏感源参数
  'POST /material-sources/config/test', // T-65：测试当前用户已保存配置
  'DELETE /material-sources/config/{sourceId}', // T-65：删除当前用户指定源配置
  'GET /metrics', // T-60：只读小时级指标快照
  'POST /metrics/recompute', // T-63：运维修复指定小时指标快照
] as const;

describe('G5 静态防线③：OpenAPI 不得出现平台发布写路由', () => {
  it('快照中没有任何 /publish* 路径', () => {
    const doc = buildOpenApiDocument();
    expect(Object.keys(doc.paths).filter((p) => G5_FORBIDDEN_ROUTE_PATTERN.test(p))).toEqual([]);
  });

  it('路由表本身也不声明发布写路由', () => {
    const offenders = REGISTERED_ROUTES.filter(
      (r) =>
        G5_FORBIDDEN_ROUTE_PATTERN.test(r.path) &&
        WRITE_METHODS.includes(r.method.toLowerCase() as never),
    );
    expect(offenders).toEqual([]);
  });

  it('守卫真的会拦下违规文档（不是只因为当前文档恰好干净）', () => {
    const evil: OpenApiDocument = {
      openapi: '3.0.3',
      info: { title: 'x', version: '1' },
      paths: { '/publish/douyin': { post: { summary: '自动发布到抖音' } } },
    };
    expect(() => assertNoPublishRoutes(evil)).toThrow(PublishRouteViolationError);
    expect(() => assertNoPublishRoutes(evil)).toThrow(/POST \/publish\/douyin/);
  });

  it('四种写方法都被拦，读方法不误伤', () => {
    for (const method of WRITE_METHODS) {
      const doc: OpenApiDocument = {
        openapi: '3.0.3',
        info: { title: 'x', version: '1' },
        paths: { '/publish/x': { [method]: {} } },
      };
      expect(() => assertNoPublishRoutes(doc)).toThrow(PublishRouteViolationError);
    }
    const readOnly: OpenApiDocument = {
      openapi: '3.0.3',
      info: { title: 'x', version: '1' },
      paths: { '/publish-guide': { get: {} } },
    };
    expect(() => assertNoPublishRoutes(readOnly)).not.toThrow();
  });

  it('本 API 最自然的三种发布命名都被拦（AIP 自定义方法 / 子资源 / 复合动词）', () => {
    const variants = [
      '/works/{id}/publish',
      '/platforms/douyin:publish',
      '/works/{id}/export:publish',
      '/publish:video',
      '/works/{id}/publishToDouyin',
      '/works/{id}/unpublish',
      '/auto-publish',
    ];
    for (const path of variants) {
      const doc: OpenApiDocument = {
        openapi: '3.0.3',
        info: { title: 'x', version: '1' },
        paths: { [path]: { post: {} } },
      };
      expect(() => assertNoPublishRoutes(doc), `${path} 未被拦下`).toThrow(
        PublishRouteViolationError,
      );
    }
  });

  it('只读指引路由不误报：GET /publish-guide 与 GET /publishing-guide 放行', () => {
    for (const path of ['/publish-guide', '/publishing-guide', '/works/{id}/publish-guide']) {
      const doc: OpenApiDocument = {
        openapi: '3.0.3',
        info: { title: 'x', version: '1' },
        paths: { [path]: { get: {} } },
      };
      expect(() => assertNoPublishRoutes(doc), `${path} 被误拦`).not.toThrow();
    }
  });

  it('fail-closed：publish 后接字母的写路由一律拦（宁可误拦不可漏放）', () => {
    const doc: OpenApiDocument = {
      openapi: '3.0.3',
      info: { title: 'x', version: '1' },
      paths: { '/publishing': { post: {} } },
    };
    expect(() => assertNoPublishRoutes(doc)).toThrow(PublishRouteViolationError);
  });
});

describe('OpenAPI 快照可 diff（T-05 验收）', () => {
  it('重复构建结果完全一致（注册表不累积状态）', () => {
    expect(buildOpenApiDocument()).toEqual(buildOpenApiDocument());
  });

  it('入库快照与当前契约一致，改了契约忘记重生成会被这条测试抓住', () => {
    const onDisk = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')) as OpenApiDocument;
    expect(onDisk).toEqual(buildOpenApiDocument());
  });

  it('SPEC §5 的每条 P0 路由都已注册，且没有夹带未经声明的新路由', () => {
    const registered = new Set(REGISTERED_ROUTES.map((r) => `${r.method.toUpperCase()} ${r.path}`));
    const missing = SPEC_P0_ROUTES.filter((r) => !registered.has(r));
    expect(missing, 'SPEC §5 的 P0 路由缺失').toEqual([]);

    const extra = [...registered].filter((r) => !SPEC_P0_ROUTES.includes(r as never));
    expect(extra.sort(), '超出 SPEC §5 的路由必须先在 DECLARED_EXTRA_ROUTES 里说明依据').toEqual(
      [...DECLARED_EXTRA_ROUTES].sort(),
    );
  });

  it('内部接口与 P1 路由不进公开契约', () => {
    const registered = new Set(REGISTERED_ROUTES.map((r) => `${r.method.toUpperCase()} ${r.path}`));
    for (const r of [
      'POST /quota:reserve',
      'POST /quota:release',
      'GET /trends',
      'PATCH /me',
      'POST /onboarding:complete',
      'POST /library:import',
      'POST /works/{id}/script:derive',
      // 只有删除与管理页是 P1；创建（POST）是 P0，已移入 SPEC_P0_ROUTES。
      'DELETE /style-samples/{id}',
    ]) {
      expect(registered.has(r), `${r} 不该出现在公开契约里`).toBe(false);
    }
  });

  it('路由表与文档操作一一对应（同 method+path 重复注册会互相覆盖）', () => {
    const doc = buildOpenApiDocument();
    const ops = Object.entries(doc.paths).flatMap(([path, item]) =>
      Object.keys(item).map((m) => `${m.toUpperCase()} ${path}`),
    );
    expect(ops.sort()).toEqual(
      REGISTERED_ROUTES.map((r) => `${r.method.toUpperCase()} ${r.path}`).sort(),
    );
    expect(new Set(ops).size).toBe(ops.length);
  });

  it('server 前缀是 /api，故发布禁令匹配的是 API 路径而非 SPA 路由', () => {
    const doc = buildOpenApiDocument() as OpenApiDocument & { servers: { url: string }[] };
    expect(doc.servers[0]?.url).toBe('/api');
  });

  it('响应体走 $ref 而非内联（内联会让快照涨到 MB 级、契约 diff 失效）', () => {
    const doc = buildOpenApiDocument();
    const refs: string[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (node === null || typeof node !== 'object') return;
      for (const [k, v] of Object.entries(node)) {
        if (k === '$ref' && typeof v === 'string') refs.push(v);
        else walk(v);
      }
    };
    walk(doc);
    expect(refs.length).toBeGreaterThan(200);

    const schemas = (doc.components?.schemas ?? {}) as Record<string, unknown>;
    const dangling = [...new Set(refs)].filter(
      (r) =>
        !r.startsWith('#/components/schemas/') ||
        !(r.slice('#/components/schemas/'.length) in schemas),
    );
    expect(dangling).toEqual([]);
  });

  it('每条错误响应都引用同一个 ApiError 组件，而不是各内联一份判别联合', () => {
    const doc = buildOpenApiDocument();
    let checked = 0;
    for (const item of Object.values(doc.paths)) {
      for (const op of Object.values(
        item as Record<
          string,
          { responses?: Record<string, { content?: Record<string, { schema?: unknown }> }> }
        >,
      )) {
        for (const [status, res] of Object.entries(op.responses ?? {})) {
          if (!/^4\d\d$|^5\d\d$/.test(status)) continue;
          const schema = res.content?.['application/json']?.schema;
          expect(schema, `${status} 错误响应缺 schema`).toEqual({
            $ref: '#/components/schemas/ApiError',
          });
          checked++;
        }
      }
    }
    // 下限按「每个操作至少 3 条错误响应」推算，只为抓住循环空转；
    // 真正的断言是上面逐条 toEqual($ref)，不是这个总数。
    expect(checked).toBeGreaterThanOrEqual(REGISTERED_ROUTES.length * 3);
  });

  it('快照体量维持在可人工 diff 的量级（< 400 KB）', () => {
    expect(readFileSync(SNAPSHOT_PATH, 'utf8').length).toBeLessThan(400_000);
  });
});

describe('契约完整性', () => {
  it('18 个落库枚举都作为组件出现，前后端与 E2E 共用同一份值域', () => {
    const doc = buildOpenApiDocument();
    const schemas = (doc.components?.schemas ?? {}) as Record<string, { enum?: string[] }>;
    for (const [name, schema] of Object.entries(DB_ENUMS)) {
      expect(schemas[name], `缺少组件 ${name}`).toBeDefined();
      expect(schemas[name]?.enum).toEqual([...schema.values]);
    }
  });

  it('每条标注了人工把关门的路由都声明 409', () => {
    const doc = buildOpenApiDocument();
    const gated = REGISTERED_ROUTES.filter((r) => r.gate !== null);
    expect(gated.length).toBeGreaterThan(0);
    for (const r of gated) {
      const item = doc.paths[r.path] as Record<string, { responses: Record<string, unknown> }>;
      const op = item[r.method.toLowerCase()];
      expect(op, `${r.method} ${r.path} 未注册`).toBeDefined();
      expect(op?.responses['409'], `${r.method} ${r.path} 缺 409`).toBeDefined();
    }
  });

  it('付费动作声明 402，0 点草稿不声明 402', () => {
    const doc = buildOpenApiDocument();
    const responsesOf = (path: string, method: string) =>
      (doc.paths[path] as Record<string, { responses: Record<string, unknown> }>)[method]!
        .responses;
    expect(responsesOf('/works/{id}/video:render', 'post')['402']).toBeDefined();
    expect(responsesOf('/works/{id}/video:patch', 'post')['402']).toBeDefined();
    expect(responsesOf('/works/{id}/video:draft', 'post')['402']).toBeUndefined();
  });

  it('导出路由声明 409 与 422（G4 服务端重算合规）', () => {
    const doc = buildOpenApiDocument();
    const op = (
      doc.paths['/works/{id}/export'] as Record<string, { responses: Record<string, unknown> }>
    ).post!;
    expect(op.responses['409']).toBeDefined();
    expect(op.responses['422']).toBeDefined();
  });

  it('派生路由的门标注体现 A1 收窄：metadata→G2，media→G3', () => {
    const r = REGISTERED_ROUTES.find((x) => x.path === '/works/{id}/derivatives:generate');
    expect(r?.gate).toBe('G2|G3');
  });
});

/**
 * 回归：`POST /style-samples` 曾被误归 P1，并被写进「禁入公开契约」的硬断言里，
 * 于是「它不存在」成了验收标准。它是 P0（SPEC §3.4 spec:319 / §5 spec:562、
 * plan T-32 plan:143 → S4 plan:426、§12.2 step 9 plan:533）。
 * 本组测试的作用是让任何再次把它删掉或放宽其请求体的改动立刻失败。
 */
describe('回归：风格样本创建是 P0，且服务端权威字段不可被客户端覆盖', () => {
  const postOp = () =>
    (
      buildOpenApiDocument().paths['/style-samples'] as Record<
        string,
        {
          requestBody?: { content: Record<string, { schema?: { $ref?: string } }> };
          responses: Record<string, unknown>;
        }
      >
    ).post;

  it('POST /style-samples 已注册（缺它则 M1 §12.2 step 9 无法执行）', () => {
    expect(REGISTERED_ROUTES.map((r) => `${r.method} ${r.path}`)).toContain('POST /style-samples');
    expect(postOp()).toBeDefined();
  });

  it('202 异步接受：入库 status=learning，不得声明 200/201 让前端以为可直接 restyle', () => {
    const op = postOp()!;
    expect(op.responses['202']).toBeDefined();
    expect(op.responses['200']).toBeUndefined();
    expect(op.responses['201']).toBeUndefined();
    // 0 点（SPEC §7 spec:651）故无 402；路径无资源 id 故无 404；需限频故有 429。
    expect(op.responses['429']).toBeDefined();
    expect(op.responses['402']).toBeUndefined();
    expect(op.responses['404']).toBeUndefined();
  });

  it('请求体拒绝客户端传 status / charCount —— 是 400 拒绝，不是静默 strip', () => {
    const base = {
      title: '费曼学习法口播稿',
      content: '你有没有过这种经历……',
      source: 'paste' as const,
    };
    expect(CreateStyleSampleRequest.parse(base)).toEqual(base);

    // status/charCount 由服务端权威决定（arch:446 DEFAULT 'learning' / arch:447 服务端计算）。
    // 若放行 status:'ready'，客户端就能跳过画像抽取，让 restyle 拿没学过的样本当输入。
    for (const forged of [
      { status: 'ready' },
      { status: 'learning' },
      { charCount: 999 },
      { charCount: 0 },
      { status: 'ready', charCount: 999 },
      { id: 'ss_forged' },
      { createdAt: '2026-11-13T00:00:00Z' },
    ]) {
      const res = CreateStyleSampleRequest.safeParse({ ...base, ...forged });
      expect(res.success, `多传 ${JSON.stringify(forged)} 应被拒绝而非忽略`).toBe(false);
    }
  });

  it('公开契约的请求体只含 title/content/source，且 additionalProperties=false', () => {
    const op = postOp()!;
    expect(op.requestBody?.content['application/json']?.schema?.$ref).toBe(
      '#/components/schemas/CreateStyleSampleRequest',
    );
    const schemas = buildOpenApiDocument().components?.schemas as Record<
      string,
      { properties?: Record<string, unknown>; required?: string[]; additionalProperties?: unknown }
    >;
    const body = schemas.CreateStyleSampleRequest!;
    expect(Object.keys(body.properties ?? {}).sort()).toEqual(['content', 'source', 'title']);
    expect([...(body.required ?? [])].sort()).toEqual(['content', 'source', 'title']);
    // 契约层也要 closed：只改 zod 不改快照会被上一条测试抓，只改快照不改 zod 会被这条抓。
    expect(body.additionalProperties).toBe(false);
  });

  it('title 上限对齐 DDL VARCHAR(255)，source 值域与响应 schema 同源', () => {
    const base = { content: '正文', source: 'upload' as const };
    expect(CreateStyleSampleRequest.safeParse({ ...base, title: 'a'.repeat(255) }).success).toBe(
      true,
    );
    expect(CreateStyleSampleRequest.safeParse({ ...base, title: 'a'.repeat(256) }).success).toBe(
      false,
    );
    expect(CreateStyleSampleRequest.safeParse({ ...base, title: '' }).success).toBe(false);
    expect(CreateStyleSampleRequest.safeParse({ ...base, content: '' }).success).toBe(false);
    expect(
      CreateStyleSampleRequest.safeParse({ ...base, title: 'x', source: 'import' }).success,
    ).toBe(false);
    // 请求与响应共用同一个 ENUM 实例，杜绝两处各抄一份导致值域漂移（arch:445）。
    expect(CreateStyleSampleRequest.shape.source).toBe(StyleSampleSchema.shape.source);
  });
});
