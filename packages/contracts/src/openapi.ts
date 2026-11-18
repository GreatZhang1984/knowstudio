import {
  OpenAPIRegistry,
  OpenApiGeneratorV3,
  extendZodWithOpenApi,
  type RouteConfig,
} from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import {
  AttachMaterialLicenseRequest,
  AttachMaterialLicenseResponse,
  CollectMaterialRequest,
  CollectMaterialResponse,
  ComplianceResponse,
  ConfirmScriptResponse,
  CreateStyleSampleRequest,
  CreateWorkRequest,
  DerivativesResponse,
  ExternalMaterialSourceId,
  ExportAccepted,
  ExportPackageSchema,
  GenerateDerivativesRequest,
  GenerateScriptRequest,
  GenerateTopicsRequest,
  HunkActionResponse,
  JobSchema,
  LedgerEntrySchema,
  LedgerQuery,
  LibraryQuery,
  ListWorksQuery,
  LoginRequest,
  MaterialSchema,
  MaterialSourceConfigRequest,
  MaterialSourceConfigResponse,
  MaterialSourceConfigTestRequest,
  MaterialSourceConfigTestResponse,
  MaterialSourceSchema,
  MaterialSourcesResponse,
  MeResponse,
  MetricRecomputeAccepted,
  MetricRecomputeRequest,
  MetricsResponse,
  PatchDerivativeRequest,
  PatchScriptRequest,
  PatchScriptResponse,
  PatchVideoRequest,
  PatchVideoResponse,
  PatchWorkRequest,
  PlatformRuleSchema,
  QuotaResponse,
  RenderAccepted,
  RenderRequest,
  RecordEventsRequest,
  RecordEventsResponse,
  ReplaceMaterialRequest,
  RestyleRequest,
  RestyleResponse,
  RerollAccepted,
  SearchAccepted,
  SearchRequest,
  SearchSessionSchema,
  SelectTopicRequest,
  StyleProfileSchema,
  StyleSampleSchema,
  TitleRegenerateResponse,
  TokenPair,
  TopicBatchSchema,
  TopicsQuery,
  UnlockScriptResponse,
  VideoPatchRequest,
  WorkListItem,
  pageOf,
} from './api.js';
import { ApiErrorSchema } from './errors.js';
import { PrefixedId, QueryBoolean, WorkEnvelopeSchema } from './dto.js';
import { DB_ENUMS, PlatformId } from './enums.js';
import { SseEventSchema } from './sse.js';
import { ScriptSchema } from './script.js';

extendZodWithOpenApi(z);

/**
 * G5 静态防线③（架构 §5.5）：OpenAPI 快照中不得出现任何平台发布写路由。
 * 系统永不自动发布——导出后由用户本人登录各平台发布（SPEC §2.3）。
 * 注意：前端 SPA 的 /publish/[id] 是派生页路由，不是 API 路由，不在此列。
 *
 * 本 API 用 AIP 自定义方法命名（`topics:reroll`），发布语义可能落在段首、`:` 之后
 * 或复合动词里；只锚定 `^/publish` 会漏掉 `/works/{id}/publish` 与
 * `/platforms/douyin:publish` 这两种最自然的写法。尾边界不含 `-`/`_`，
 * 故只读指引 `/publish-guide` 不误报。
 *
 * 刻意 fail-closed：`publishing` 这类延续词也算命中。G5 是产品硬约束，
 * 漏放一条发布写路由的代价远大于误拦一条只读指引——而守卫只检查写方法，
 * `GET /publishing-guide` 依然放行。
 */
export const G5_FORBIDDEN_ROUTE_PATTERN = /(?:^|\/|:)[a-z0-9_-]*publish(?:$|\/|:|[A-Za-z])/i;
const WRITE_METHODS = ['post', 'put', 'patch', 'delete'] as const;

export class PublishRouteViolationError extends Error {
  constructor(public readonly routes: string[]) {
    super(`G5 违规：OpenAPI 出现平台发布写路由 ${routes.join(', ')}。系统永不自动发布。`);
    this.name = 'PublishRouteViolationError';
  }
}

export function assertNoPublishRoutes(doc: OpenApiDocument): void {
  const offenders: string[] = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    if (!G5_FORBIDDEN_ROUTE_PATTERN.test(path)) continue;
    for (const method of WRITE_METHODS) {
      if (item[method]) offenders.push(`${method.toUpperCase()} ${path}`);
    }
  }
  if (offenders.length > 0) throw new PublishRouteViolationError(offenders);
}

type PathItem = Record<string, unknown>;
export interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, PathItem>;
  components?: Record<string, unknown>;
}

/**
 * `registry.register()` 返回**新的**包装实例——refId 挂在实例上而不改原对象。
 * 路由必须引用返回值，否则整份文档内联展开、`$ref` 为 0，契约 diff 门禁失效。
 */
const NAMED_SCHEMAS = {
  ApiError: ApiErrorSchema,
  WorkEnvelope: WorkEnvelopeSchema,
  Quota: QuotaResponse,
  Job: JobSchema,
  Script: ScriptSchema,
  SseEvent: SseEventSchema,
  WorkListItem,
  Material: MaterialSchema,
  MaterialSource: MaterialSourceSchema,
  MaterialSources: MaterialSourcesResponse,
  MaterialSourceConfigRequest,
  MaterialSourceConfigResponse,
  MaterialSourceConfigTestRequest,
  MaterialSourceConfigTestResponse,
  TopicBatch: TopicBatchSchema,
  SearchSession: SearchSessionSchema,
  SearchRequest,
  SearchAccepted,
  RerollAccepted,
  CollectMaterialRequest,
  CollectMaterialResponse,
  ReplaceMaterialRequest,
  AttachMaterialLicenseRequest,
  AttachMaterialLicenseResponse,
  GenerateTopicsRequest,
  SelectTopicRequest,
  GenerateScriptRequest,
  PatchScriptRequest,
  PatchScriptResponse,
  ConfirmScriptResponse,
  UnlockScriptResponse,
  RestyleRequest,
  RestyleResponse,
  HunkActionResponse,
  RenderRequest,
  RenderAccepted,
  PatchVideoRequest,
  PatchVideoResponse,
  VideoPatchRequest,
  GenerateDerivativesRequest,
  PatchDerivativeRequest,
  DerivativesResponse,
  TitleRegenerateResponse,
  ComplianceReport: ComplianceResponse,
  ExportPackage: ExportPackageSchema,
  ExportAccepted,
  PlatformRule: PlatformRuleSchema,
  Metrics: MetricsResponse,
  MetricRecomputeRequest,
  MetricRecomputeAccepted,
  RecordEventsRequest,
  RecordEventsResponse,
  PlatformId,
  LoginRequest,
  TokenPair,
  CreateWorkRequest,
  PatchWorkRequest,
  MeResponse,
  StyleSample: StyleSampleSchema,
  CreateStyleSampleRequest,
  StyleProfile: StyleProfileSchema,
  LedgerEntry: LedgerEntrySchema,
} as const;

type SchemaRefs = { [K in keyof typeof NAMED_SCHEMAS]: (typeof NAMED_SCHEMAS)[K] };

function createRegistry(): { registry: OpenAPIRegistry; refs: SchemaRefs } {
  const registry = new OpenAPIRegistry();
  const refs = {} as SchemaRefs;
  const sink = refs as Record<string, z.ZodTypeAny>;
  for (const [name, schema] of Object.entries(NAMED_SCHEMAS)) {
    sink[name] = registry.register(name, schema);
  }
  // 18 个落库枚举作为**公开值域**发布（T-05 验收）：多数只在父 schema 内部出现，
  // 因父 schema 由 dto/api 用原始枚举构造，故这里是值域声明而非 $ref 目标。
  for (const [name, schema] of Object.entries(DB_ENUMS)) registry.register(name, schema);
  return { registry, refs };
}

const json = (schema: z.ZodTypeAny) => ({ 'application/json': { schema } });

type ErrStatus = 400 | 401 | 402 | 404 | 409 | 422 | 429 | 502 | 503;

const ERR_DESCRIPTIONS: Record<ErrStatus, string> = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHENTICATED',
  402: 'QUOTA_INSUFFICIENT（携带 need/left/resetAt 三条出路）',
  404: 'NOT_FOUND（不存在或不属于你）',
  409: 'GATE_NOT_SATISFIED / RENDER_IN_PROGRESS / SCRIPT_LOCKED / AUTOSAVE_CONFLICT / STALE_ASSET',
  422: 'COMPLIANCE_BLOCKED',
  429: 'RATE_LIMITED',
  502: 'UPSTREAM_FAILED（供应商全失败）',
  503: 'RENDER_QUEUE_UNAVAILABLE',
};

/**
 * 按路由能力挑选错误响应，而不是把 400/401/404/409/422 无条件铺给所有路由——
 * 给 `POST /auth/login` 声明 404/409/422 是契约噪声，会误导前端写无用的错误分支。
 */
const err = (r: SchemaRefs, statuses: readonly ErrStatus[]): RouteConfig['responses'] =>
  Object.fromEntries(
    statuses.map((s) => [s, { description: ERR_DESCRIPTIONS[s], content: json(r.ApiError) }]),
  );

/** 未鉴权入口：无资源归属、无闸门、无合规。 */
const PUBLIC = [400, 401, 429] as const;
/** 已鉴权但不指向具体资源（/me、/quota、/platform-rules）。 */
const AUTH = [401, 429] as const;
/** 列表与新建：400 来自查询/ body 校验，不存在 404。 */
const COLLECTION = [400, 401, 429] as const;
/** 读单资源：跨用户一律 404。 */
const READ = [401, 404, 429] as const;
/** 写单资源。 */
const WRITE = [400, 401, 404, 429] as const;
/** 受人工把关门约束的写：多一个 409。 */
const GATED = [400, 401, 404, 409, 429] as const;

interface RouteDef {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  path: string;
  summary: string;
  gate?: string;
  request?: RouteConfig['request'];
  responses: RouteConfig['responses'];
}

/**
 * P0 路由表，逐条对齐 SPEC §5（第 551–563 行）+ 架构 §10.3。
 * 门标注仅为文档用途；权威判定在 domain/gates 的路由映射与服务端 Guard。
 *
 * **本轮故意未覆盖的 SPEC §5 路由**（不是遗漏，是范围切分）：
 * - `GET /trends`、`POST /onboarding:complete`、`PATCH /me` —— P1（SPEC §1.5）
 * - `POST /library:import`、`GET|PATCH|DELETE /library/{id}` —— P1 完整素材库；
 *   P0 只交付 `GET /library` 最小读取（SPEC §1.5 注）
 * - `DELETE /style-samples/{id}` —— P1 样本管理（SPEC §1.5 spec:81、§2.5 spec:190
 *   管理页标 P1、plan S-M2-6 plan:66）。**只有删除与管理页是 P1**，创建是 P0，见下段
 * - `POST /works/{id}/script:derive` —— SPEC §5 明写 P1
 * - `POST /quota:reserve`、`POST /quota:release` —— 架构 §10.3 定为**内部接口**，
 *   仅 worker 服务间令牌可调，不对浏览器暴露，故不进公开契约
 *
 * **风格样本的 P0/P1 切分（本轮修正，勿再回退）**：`POST /style-samples` 属 **P0**，已注册。
 * 依据：① SPEC §3.4 spec:319「`/settings/style` 上传或粘贴过往文案；**P0 需支持 ≥3 篇**」；
 * ② SPEC §5 spec:562 风格行逐个列出 `GET /style-samples` · `POST /style-samples` ·
 * `DELETE /style-samples/:id` · `GET /style-profile`，并未把 POST 标 P1（对比同行
 * `script:derive` 是明写 P1 的）；③ SPEC §6 spec:615「样本 <1 篇时禁用并引导上传」——
 * restyle 是 P0，产生样本的写接口就是 P0 前提；④ plan T-32 plan:143 范围「上传/粘贴 ≥3 篇」、
 * 验收「AC-S5 样本可上传」，落在 S4 plan:426（M1）；⑤ plan §12.2 step 9 plan:533
 * 「上传 3 篇风格样本 → style_sample 3 行 ready、style_profile.sampleCount=3」由 T-61
 * 全剧本自动化跑，缺此路由 M1 验收必然失败；⑥ plan §2 plan:31 M1 可演示增量同样以
 * 「上传 3 篇样本」开头。此前整体归 P1，是把 SPEC §1.5 spec:81「风格样本管理」
 * （= 管理页 + 删除）误读成「样本的一切写操作」，而 `StyleSampleSchema.source` 早就有
 * `upload|paste` 枚举却没有任何能产生样本的接口——与「SSE 契约已交付但没有承载它的路由」同型。
 *
 * **待补的门映射**：`script:restyle`、`script/hunks/{hid}:accept|:reject`、
 * `derivatives/{platformId}/title:regenerate` 是本轮新增路由，架构 §5.3 的门表
 * 只有 7 个动作、尚未覆盖它们，故这里**不标 gate**——标了就等于宣称服务端强制，
 * 而 domain 的 `requiredGate` 并无对应条目。需先扩架构 §5.3 与 `GateAction`，
 * 再回填标注。它们仍声明 409，因为 SCRIPT_LOCKED / RENDER_IN_PROGRESS 确实可能。
 *
 * **超出 SPEC §5 的三条路由**（已在 test/openapi.test.ts 的 DECLARED_EXTRA_ROUTES 登记）：
 * `POST /auth/refresh` 依据架构 §10.1；`GET /works/{id}/script` 与
 * `GET /works/{id}/derivatives` 是 SPEC 缺口——§5 只给了 PATCH，但刷新后必须能读回
 * lines 与四平台派生正文，而信封不含它们。这两条待产品确认，不视为已定需求。
 */
function routeDefs(r: SchemaRefs): RouteDef[] {
  const idParams = z.object({ id: PrefixedId });
  const hunkParams = z.object({ id: PrefixedId, hid: PrefixedId });
  const platformParams = z.object({ id: PrefixedId, platformId: r.PlatformId });

  return [
    // ── 鉴权与账户 ──
    {
      method: 'post',
      path: '/auth/login',
      summary: '登录',
      request: { body: { content: json(r.LoginRequest) } },
      responses: { 200: { description: 'OK', content: json(r.TokenPair) }, ...err(r, PUBLIC) },
    },
    {
      method: 'post',
      path: '/auth/refresh',
      summary: '刷新 accessToken（HttpOnly Cookie）',
      responses: { 200: { description: 'OK', content: json(r.TokenPair) }, ...err(r, PUBLIC) },
    },
    {
      method: 'post',
      path: '/auth/logout',
      summary: '吊销 refresh',
      responses: { 204: { description: 'No Content' }, ...err(r, AUTH) },
    },
    {
      method: 'get',
      path: '/me',
      summary: '当前用户身份与偏好（不含任何凭据字段）',
      responses: { 200: { description: 'OK', content: json(r.MeResponse) }, ...err(r, AUTH) },
    },

    // ── 作品 ──
    {
      method: 'post',
      path: '/works',
      summary: '新建 Work（不继承任何旧 Work 状态，D-05）',
      request: { body: { content: json(r.CreateWorkRequest) } },
      responses: {
        201: { description: 'Created', content: json(r.WorkEnvelope) },
        ...err(r, COLLECTION),
      },
    },
    {
      method: 'get',
      path: '/works',
      summary: '作品列表（游标分页）',
      request: { query: ListWorksQuery },
      responses: {
        200: { description: 'OK', content: json(pageOf(r.WorkListItem)) },
        ...err(r, COLLECTION),
      },
    },
    {
      method: 'get',
      path: '/works/{id}',
      summary: 'Work 统一信封（gates/step/progress/quota）',
      request: { params: idParams },
      responses: { 200: { description: 'OK', content: json(r.WorkEnvelope) }, ...err(r, READ) },
    },
    {
      method: 'patch',
      path: '/works/{id}',
      summary: '改标题',
      request: { params: idParams, body: { content: json(r.PatchWorkRequest) } },
      responses: { 200: { description: 'OK', content: json(r.WorkEnvelope) }, ...err(r, WRITE) },
    },
    {
      method: 'delete',
      path: '/works/{id}',
      summary: '软删除 Work',
      request: { params: idParams },
      responses: { 204: { description: 'No Content' }, ...err(r, WRITE) },
    },

    // ── 搜索与素材收藏 ──
    {
      method: 'get',
      path: '/material-sources',
      summary: '可选素材源与配置状态（不暴露外部服务地址或密钥）',
      responses: { 200: { description: 'OK', content: json(r.MaterialSources) }, ...err(r, AUTH) },
    },
    {
      method: 'get',
      path: '/material-sources/config',
      summary: '读取当前用户素材源配置（API Key 只返回末四位）',
      responses: {
        200: { description: 'OK', content: json(r.MaterialSourceConfigResponse) },
        ...err(r, AUTH),
      },
    },
    {
      method: 'put',
      path: '/material-sources/config',
      summary: '保存当前用户 Web Search / Obsidian 配置',
      request: { body: { content: json(r.MaterialSourceConfigRequest) } },
      responses: {
        200: { description: 'OK', content: json(r.MaterialSourceConfigResponse) },
        ...err(r, COLLECTION),
      },
    },
    {
      method: 'post',
      path: '/material-sources/config/test',
      summary: '测试已保存的真实素材源连通性',
      request: { body: { content: json(r.MaterialSourceConfigTestRequest) } },
      responses: {
        200: { description: 'OK', content: json(r.MaterialSourceConfigTestResponse) },
        ...err(r, COLLECTION),
      },
    },
    {
      method: 'delete',
      path: '/material-sources/config/{sourceId}',
      summary: '删除当前用户的指定素材源配置',
      request: { params: z.object({ sourceId: ExternalMaterialSourceId }) },
      responses: { 204: { description: 'No Content' }, ...err(r, AUTH) },
    },
    {
      method: 'post',
      path: '/discover/search',
      summary: '素材聚合（202；24h 缓存命中直接 200）',
      request: { body: { content: json(r.SearchRequest) } },
      responses: {
        200: { description: '缓存命中', content: json(r.SearchSession) },
        202: { description: 'Accepted', content: json(r.SearchAccepted) },
        ...err(r, [...COLLECTION, 502]),
      },
    },
    {
      method: 'get',
      path: '/discover/search/{id}',
      summary: '搜索部分结果（1s 轮询）',
      request: { params: idParams },
      responses: { 200: { description: 'OK', content: json(r.SearchSession) }, ...err(r, READ) },
    },
    {
      method: 'post',
      path: '/works/{id}/materials',
      summary: '收藏素材落库（触发 material:firstCollect）',
      request: { params: idParams, body: { content: json(r.CollectMaterialRequest) } },
      responses: {
        200: { description: 'OK', content: json(r.CollectMaterialResponse) },
        ...err(r, WRITE),
      },
    },
    {
      method: 'delete',
      path: '/works/{id}/materials/{mid}',
      summary: '取消收藏',
      request: { params: z.object({ id: PrefixedId, mid: PrefixedId }) },
      responses: {
        200: { description: 'OK', content: json(r.CollectMaterialResponse) },
        ...err(r, WRITE),
      },
    },
    {
      method: 'post',
      path: '/works/{id}/materials/{mid}/replace',
      summary: '同类型素材替换并按需重算课件（T-55 修复路径）',
      request: {
        params: z.object({ id: PrefixedId, mid: PrefixedId }),
        body: { content: json(r.ReplaceMaterialRequest) },
      },
      responses: {
        200: { description: 'OK', content: json(r.CollectMaterialResponse) },
        ...err(r, WRITE),
      },
    },
    {
      method: 'post',
      path: '/works/{id}/materials/{mid}/license',
      summary: '绑定素材商用授权凭证并复检合规（T-55 修复路径）',
      request: {
        params: z.object({ id: PrefixedId, mid: PrefixedId }),
        body: { content: json(r.AttachMaterialLicenseRequest) },
      },
      responses: {
        200: { description: 'OK', content: json(r.AttachMaterialLicenseResponse) },
        ...err(r, WRITE),
      },
    },

    // ── 选题 ──
    {
      method: 'post',
      path: '/works/{id}/topics:generate',
      summary: '首批选题脑暴（≥10 差异化角度，G1 的前提）',
      request: { params: idParams, body: { content: json(r.GenerateTopicsRequest) } },
      responses: { 202: { description: 'Accepted', content: json(r.Job) }, ...err(r, WRITE) },
    },
    {
      method: 'get',
      path: '/works/{id}/topics',
      summary: '选题批次（?batch= 取历史批）',
      request: { params: idParams, query: TopicsQuery },
      responses: { 200: { description: 'OK', content: json(r.TopicBatch) }, ...err(r, READ) },
    },
    {
      method: 'post',
      path: '/works/{id}/topics:reroll',
      summary: '换一批（新批次，跨批指纹去重，不走缓存，D-09）',
      request: { params: idParams },
      responses: {
        202: { description: 'Accepted', content: json(r.RerollAccepted) },
        ...err(r, WRITE),
      },
    },
    {
      method: 'post',
      path: '/works/{id}/topic:select',
      summary: '选定角度 → 置 G1（SPEC §5 用单数 topic）',
      // 不标 gate：本路由是**置** G1 的动作，不是**要求** G1 的动作（同 script:confirm 置 G2）。
      request: { params: idParams, body: { content: json(r.SelectTopicRequest) } },
      responses: { 200: { description: 'OK', content: json(r.WorkEnvelope) }, ...err(r, WRITE) },
    },

    // ── 文案 ──
    {
      method: 'post',
      path: '/works/{id}/script:generate',
      summary: '生成口播文案',
      gate: 'G1',
      request: { params: idParams, body: { content: json(r.GenerateScriptRequest) } },
      responses: { 202: { description: 'Accepted', content: json(r.Job) }, ...err(r, GATED) },
    },
    {
      method: 'get',
      path: '/works/{id}/script',
      summary: '读取文案',
      request: { params: idParams },
      responses: { 200: { description: 'OK', content: json(r.Script) }, ...err(r, READ) },
    },
    {
      method: 'patch',
      path: '/works/{id}/script',
      summary: 'autosave（携带 baseVersion，不匹配 → 409 双版本快照）',
      request: { params: idParams, body: { content: json(r.PatchScriptRequest) } },
      responses: {
        200: { description: 'OK', content: json(r.PatchScriptResponse) },
        ...err(r, GATED),
      },
    },
    {
      method: 'post',
      path: '/works/{id}/script:restyle',
      summary: '风格重写 → 句级 hunk 列表（D-12：不是只弹 toast）',
      request: { params: idParams, body: { content: json(r.RestyleRequest) } },
      responses: { 200: { description: 'OK', content: json(r.RestyleResponse) }, ...err(r, GATED) },
    },
    {
      method: 'post',
      path: '/works/{id}/script/hunks/{hid}:accept',
      summary: '接受该句重写 → 落 script_revision',
      request: { params: hunkParams },
      responses: {
        200: { description: 'OK', content: json(r.HunkActionResponse) },
        ...err(r, GATED),
      },
    },
    {
      method: 'post',
      path: '/works/{id}/script/hunks/{hid}:reject',
      summary: '拒绝该句重写 → 保留原句',
      request: { params: hunkParams },
      responses: {
        200: { description: 'OK', content: json(r.HunkActionResponse) },
        ...err(r, GATED),
      },
    },
    {
      method: 'post',
      path: '/works/{id}/script:confirm',
      summary: '人工确认 → 置 G2',
      request: { params: idParams },
      responses: {
        200: { description: 'OK', content: json(r.ConfirmScriptResponse) },
        ...err(r, WRITE),
      },
    },
    {
      method: 'post',
      path: '/works/{id}/script:unlock',
      summary: '解锁 → G2/G3/G4 失效 + asset.stale',
      request: { params: idParams },
      responses: {
        200: { description: 'OK', content: json(r.UnlockScriptResponse) },
        ...err(r, WRITE),
      },
    },

    // ── 视频与渲染 ──
    {
      method: 'post',
      path: '/works/{id}/video:draft',
      summary: '低清草稿（0 点，仍受并发上限 1）',
      gate: 'G2',
      request: { params: idParams, body: { content: json(r.RenderRequest) } },
      responses: {
        202: { description: 'Accepted', content: json(r.RenderAccepted) },
        ...err(r, [...GATED, 503]),
      },
    },
    {
      method: 'post',
      path: '/works/{id}/video:render',
      summary: '高清渲染（预扣与入队同一事务）',
      gate: 'G2',
      request: { params: idParams, body: { content: json(r.RenderRequest) } },
      responses: {
        202: { description: 'Accepted', content: json(r.RenderAccepted) },
        ...err(r, [...GATED, 402, 503]),
      },
    },
    {
      method: 'patch',
      path: '/works/{id}/video',
      summary: '微调预览：只返回增量点数，不下单',
      gate: 'G2',
      request: { params: idParams, body: { content: json(r.PatchVideoRequest) } },
      responses: {
        200: { description: 'OK', content: json(r.PatchVideoResponse) },
        ...err(r, GATED),
      },
    },
    {
      method: 'post',
      path: '/works/{id}/video:patch',
      summary: '局部重算（0 点时不产生 reservation）',
      gate: 'G2',
      request: { params: idParams, body: { content: json(r.VideoPatchRequest) } },
      responses: {
        202: { description: 'Accepted', content: json(r.RenderAccepted) },
        ...err(r, [...GATED, 402, 503]),
      },
    },

    // ── 任务 ──
    {
      method: 'get',
      path: '/jobs/{id}',
      summary: '任务状态（SSE 降级轮询，stage 与 SSE 同源）',
      request: { params: idParams },
      responses: { 200: { description: 'OK', content: json(r.Job) }, ...err(r, READ) },
    },
    {
      method: 'get',
      path: '/jobs/{id}/events',
      summary: 'SSE 事件流（渲染/派生/导出；Last-Event-ID 续传）',
      request: { params: idParams },
      responses: {
        200: {
          description: 'text/event-stream；事件联合见 SseEvent，心跳是注释行不是事件',
          content: { 'text/event-stream': { schema: r.SseEvent } },
        },
        ...err(r, READ),
      },
    },
    {
      method: 'post',
      path: '/jobs/{id}:retry',
      summary: '重试（复用 reservation，不重复扣点）',
      request: { params: idParams },
      responses: {
        202: { description: 'Accepted', content: json(r.RenderAccepted) },
        ...err(r, WRITE),
      },
    },
    {
      method: 'post',
      path: '/jobs/{id}:cancel',
      summary: '取消（阶段边界退出 → release）',
      request: { params: idParams },
      responses: { 200: { description: 'OK', content: json(r.Job) }, ...err(r, WRITE) },
    },

    // ── 派生 ──
    {
      method: 'post',
      path: '/works/{id}/derivatives:generate',
      summary: '派生（scope=metadata 仅需 G2；scope=media 需 G3）',
      gate: 'G2|G3',
      request: { params: idParams, body: { content: json(r.GenerateDerivativesRequest) } },
      responses: {
        202: { description: 'Accepted', content: json(r.RenderAccepted) },
        ...err(r, GATED),
      },
    },
    {
      method: 'get',
      path: '/works/{id}/derivatives',
      summary: '四平台派生（每平台一行，独立编辑）',
      request: { params: idParams },
      responses: {
        200: { description: 'OK', content: json(r.DerivativesResponse) },
        ...err(r, READ),
      },
    },
    {
      method: 'patch',
      path: '/works/{id}/derivatives/{platformId}',
      summary: '改单平台标题/标签/时长版本/封面',
      gate: 'G2',
      request: { params: platformParams, body: { content: json(r.PatchDerivativeRequest) } },
      responses: {
        200: { description: 'OK', content: json(r.DerivativesResponse) },
        ...err(r, GATED),
      },
    },
    {
      method: 'post',
      path: '/works/{id}/derivatives/{platformId}/title:regenerate',
      summary: '单平台标题重生成（Story 7）',
      request: { params: platformParams },
      responses: {
        200: { description: 'OK', content: json(r.TitleRegenerateResponse) },
        ...err(r, GATED),
      },
    },

    // ── 合规与导出 ──
    {
      method: 'get',
      path: '/works/{id}/compliance',
      summary: '实时合规计算（带 fingerprint，支持 force）',
      request: { params: idParams, query: z.object({ force: QueryBoolean.optional() }) },
      responses: { 200: { description: 'OK', content: json(r.ComplianceReport) }, ...err(r, READ) },
    },
    {
      method: 'post',
      path: '/works/{id}/export',
      summary: '导出（服务端重算合规，不信任客户端 reportId）',
      gate: 'G4',
      request: { params: idParams },
      responses: {
        202: { description: 'Accepted', content: json(r.ExportAccepted) },
        ...err(r, [...GATED, 422]),
      },
    },
    {
      method: 'get',
      path: '/exports/{id}',
      summary: '导出产物（过期重签 URL，不重新打包）',
      request: { params: idParams },
      responses: { 200: { description: 'OK', content: json(r.ExportPackage) }, ...err(r, READ) },
    },

    // ── 配额与平台规则 ──
    {
      method: 'get',
      path: '/quota',
      summary: '额度（全部由账本聚合，禁读缓存快照）',
      responses: { 200: { description: 'OK', content: json(r.Quota) }, ...err(r, AUTH) },
    },
    {
      method: 'post',
      path: '/events',
      summary: '前端可信事件批量上报（script_first_edit / publish_receipt_marked）',
      request: { body: { content: json(r.RecordEventsRequest) } },
      responses: {
        200: { description: 'OK', content: json(r.RecordEventsResponse) },
        ...err(r, COLLECTION),
      },
    },
    {
      method: 'get',
      path: '/metrics',
      summary: '指标快照与 sys.metric 任务健康（G4 盲测需人工录入）',
      responses: { 200: { description: 'OK', content: json(r.Metrics) }, ...err(r, AUTH) },
    },
    {
      method: 'post',
      path: '/metrics/recompute',
      summary: '运维重算指定小时指标（生产需 METRIC_RECOMPUTE_TOKEN）',
      request: { body: { content: json(r.MetricRecomputeRequest) } },
      responses: {
        202: { description: 'Accepted', content: json(r.MetricRecomputeAccepted) },
        ...err(r, [400, ...AUTH]),
      },
    },
    {
      method: 'get',
      path: '/quota/ledger',
      summary: '账本明细（按月）',
      request: { query: LedgerQuery },
      responses: {
        200: { description: 'OK', content: json(pageOf(r.LedgerEntry)) },
        ...err(r, COLLECTION),
      },
    },
    {
      method: 'get',
      path: '/platform-rules',
      summary: '四平台规则全量 + version',
      responses: {
        200: { description: 'OK', content: json(z.array(r.PlatformRule)) },
        ...err(r, AUTH),
      },
    },

    // ── 风格（P0：创建 + 读取；删除与管理页 P1）──
    {
      method: 'get',
      path: '/style-samples',
      summary: '风格样本列表（restyle 的输入前提）',
      responses: {
        200: { description: 'OK', content: json(z.array(r.StyleSample)) },
        ...err(r, AUTH),
      },
    },
    {
      method: 'post',
      path: '/style-samples',
      summary: '上传/粘贴风格样本（202；入库即 status=learning，画像异步抽取）',
      request: { body: { content: json(r.CreateStyleSampleRequest) } },
      // 202 而非 200/201：样本行同步落库，但 status=learning（arch:446 DEFAULT），
      // 画像抽取未完成前 restyle 不可用（SPEC §6 spec:615）。同 topics:generate /
      // script:generate 的「202 + 资源本体」惯例；无 style 类 JobType（enums.ts:71–81），
      // 故不发 jobId/sseUrl，轮询落在已注册的 GET /style-samples 与 GET /style-profile。
      // 错误用 COLLECTION：路径无资源 id 故无 404；风格类动作 0 点故无 402（SPEC §7 spec:651），
      // 但「需限频防滥用」故保留 429。
      responses: {
        202: {
          description:
            'Accepted：样本已入库 status=learning；轮询 GET /style-samples 取 ready、GET /style-profile 取 sampleCount/isDefault',
          content: json(r.StyleSample),
        },
        ...err(r, COLLECTION),
      },
    },
    {
      method: 'get',
      path: '/style-profile',
      summary: '风格画像（无样本时 isDefault=true，不阻断）',
      responses: { 200: { description: 'OK', content: json(r.StyleProfile) }, ...err(r, AUTH) },
    },

    // ── 素材库最小可用（完整检索 P1）──
    {
      method: 'get',
      path: '/library',
      summary: '素材库最小读取（?q=&type=&license=）',
      request: { query: LibraryQuery },
      responses: {
        200: { description: 'OK', content: json(pageOf(r.Material)) },
        ...err(r, COLLECTION),
      },
    },
  ];
}

export function buildOpenApiDocument(): OpenApiDocument {
  const { registry, refs } = createRegistry();
  for (const r of routeDefs(refs)) {
    registry.registerPath({
      method: r.method,
      path: r.path,
      summary: r.summary,
      description: r.gate
        ? `人工把关门：${r.gate}（服务端强制，未满足返回 409 GATE_NOT_SATISFIED）`
        : undefined,
      request: r.request,
      responses: r.responses,
    });
  }

  const doc = new OpenApiGeneratorV3(registry.definitions).generateDocument({
    openapi: '3.0.3',
    info: {
      title: 'KnowStudio API',
      version: '1.0.0',
      description:
        '知影工坊 P0 契约。G5 硬约束：本 API 不含任何平台发布写接口，导出后由用户本人登录各平台发布。',
    },
    servers: [{ url: '/api', description: 'v1' }],
  }) as unknown as OpenApiDocument;

  assertNoPublishRoutes(doc);
  return doc;
}

/** 供 CI 与测试断言：路由表本身也不得声明发布写路由。 */
export const REGISTERED_ROUTES = routeDefs(NAMED_SCHEMAS).map((r) => ({
  method: r.method.toUpperCase(),
  path: r.path,
  gate: r.gate ?? null,
}));
