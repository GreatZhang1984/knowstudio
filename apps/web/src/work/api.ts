import {
  ApiErrorSchema,
  AttachMaterialLicenseRequest,
  AttachMaterialLicenseResponse,
  CollectMaterialResponse,
  ComplianceReportSchema,
  CreateWorkRequest,
  DerivativesResponse,
  ExportAccepted,
  ExportPackageSchema,
  GenerateTopicsRequest,
  GenerateScriptRequest,
  JobSchema,
  LedgerEntrySchema,
  MaterialSourcesResponse,
  MaterialSchema,
  PlatformRuleSchema,
  PatchScriptRequest,
  PatchDerivativeRequest,
  PatchScriptResponse,
  SearchAccepted,
  SearchRequest,
  SearchSessionSchema,
  SelectTopicRequest,
  TopicBatchSchema,
  QuotaSchema,
  WorkEnvelopeSchema,
  WorkListItem as WorkListItemSchema,
  MetricsResponse,
  RerollAccepted,
  RestyleRequest,
  RestyleResponse,
  ScriptSchema,
  ConfirmScriptResponse,
  DerivativeSchema,
  RenderAccepted,
  RenderRequest,
  StyleProfileSchema,
  StyleSampleSchema,
  pageOf,
} from '@knowstudio/contracts';
import type {
  ApiError,
  AttachMaterialLicenseResponse as AttachMaterialLicenseResponseData,
  ComplianceReport,
  Derivative,
  ExportPackage,
  LicenseState,
  Material,
  MaterialSource,
  MaterialType,
  PlatformId,
  PlatformRule,
  Quota,
  LedgerEntry,
  Job,
  SearchSession,
  TopicBatch,
  Script,
  StyleProfile,
  StyleSample,
  MetricsResponse as MetricsResponseData,
  WorkEnvelope,
  WorkListItem,
} from '@knowstudio/contracts';
import { readAccessToken } from '../pages/login/auth-session';

/**
 * dev 默认走 fixture（离线 UI 开发）；`VITE_USE_FIXTURES=false` 时 dev 也走真实 /api 做联调。
 * 生产构建恒走真实 /api。闸门真假一律由服务端下发（架构 §5.5），本层只取信封 + 校验契约。
 * 占位数据只在 fixture 分支内动态引入：静态 import 时 fixtures 顶层的 zod parse 有副作用，
 * Rollup 不敢摇掉，实测会把演示作品标题打进生产包。
 */
export const USE_FIXTURES = import.meta.env.DEV && import.meta.env.VITE_USE_FIXTURES !== 'false';

const WorkPage = pageOf(WorkListItemSchema);

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly apiError: ApiError | null,
  ) {
    super(apiError?.code ?? `HTTP_${status}`);
    this.name = 'ApiRequestError';
  }
}

async function sendJson(path: string, init?: RequestInit): Promise<unknown> {
  const token = readAccessToken();
  const headers = new Headers(init?.headers);
  headers.set('Accept', 'application/json');
  if (token !== null) headers.set('Authorization', `Bearer ${token}`);
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers, credentials: 'include' });
  } catch {
    throw new ApiRequestError(0, null);
  }
  if (res.ok) return res.status === 204 ? null : ((await res.json()) as unknown);

  let apiError: ApiError | null = null;
  try {
    const parsed = ApiErrorSchema.safeParse((await res.json()) as unknown);
    if (parsed.success) apiError = parsed.data;
  } catch {
    // 非 JSON 或非契约错误体保留 null，页面走统一兜底错误态。
  }
  throw new ApiRequestError(res.status, apiError);
}

export async function fetchWorkEnvelope(workId: string): Promise<WorkEnvelope> {
  if (USE_FIXTURES) {
    const { FIXTURE_WORKS } = await import('./fixtures');
    const fixture = FIXTURE_WORKS.get(workId);
    if (fixture == null) throw new Error(`占位数据里没有作品 ${workId}`);
    return fixture;
  }
  return WorkEnvelopeSchema.parse(await sendJson(`/api/works/${workId}`));
}

export async function fetchRecentWork(): Promise<WorkListItem | null> {
  if (USE_FIXTURES) return (await import('./fixtures')).FIXTURE_RECENT;
  const page = WorkPage.parse(await sendJson('/api/works?limit=1'));
  return page.items[0] ?? null;
}

export async function createWork(keyword: string): Promise<WorkEnvelope> {
  const body = CreateWorkRequest.parse({ keyword });
  if (USE_FIXTURES) return (await import('./fixtures')).createFixtureWork(keyword);
  return WorkEnvelopeSchema.parse(
    await sendJson('/api/works', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

export type SearchStart =
  | { readonly kind: 'session'; readonly session: SearchSession }
  | { readonly kind: 'accepted'; readonly searchId: string };

export interface SearchInput {
  readonly workId: string;
  readonly keyword: string;
  readonly domain?: string;
  readonly force?: boolean;
  readonly sources?: readonly MaterialSource['id'][];
}

export async function fetchMaterialSources(): Promise<MaterialSourcesResponse> {
  if (USE_FIXTURES) return (await import('./fixtures')).fetchFixtureMaterialSources();
  return MaterialSourcesResponse.parse(await sendJson('/api/material-sources'));
}

export async function startSearch(input: SearchInput): Promise<SearchStart> {
  const body = SearchRequest.parse({
    workId: input.workId,
    keyword: input.keyword,
    ...(input.domain == null ? {} : { domain: input.domain }),
    ...(input.sources == null ? {} : { sources: input.sources }),
    force: input.force,
  });
  if (USE_FIXTURES) return (await import('./fixtures')).startFixtureSearch(body);
  const json = await sendJson('/api/discover/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const accepted = SearchAccepted.safeParse(json);
  if (accepted.success) return { kind: 'accepted', searchId: accepted.data.searchId };
  return { kind: 'session', session: SearchSessionSchema.parse(json) };
}

export async function fetchSearchSession(searchId: string): Promise<SearchSession> {
  if (USE_FIXTURES) return (await import('./fixtures')).fetchFixtureSearchSession(searchId);
  return SearchSessionSchema.parse(await sendJson(`/api/discover/search/${searchId}`));
}

export async function collectMaterial(
  workId: string,
  materialId: string,
  collected: boolean,
): Promise<CollectMaterialResponse> {
  if (USE_FIXTURES) {
    return (await import('./fixtures')).collectFixtureMaterial(workId, materialId, collected);
  }
  return CollectMaterialResponse.parse(
    await sendJson(
      collected ? `/api/works/${workId}/materials` : `/api/works/${workId}/materials/${materialId}`,
      collected
        ? {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ materialId }),
          }
        : { method: 'DELETE' },
    ),
  );
}

export async function replaceMaterial(
  workId: string,
  materialId: string,
  replacementId: string,
): Promise<CollectMaterialResponse> {
  if (USE_FIXTURES) {
    return (await import('./fixtures')).replaceFixtureMaterial(workId, materialId, replacementId);
  }
  return CollectMaterialResponse.parse(
    await sendJson(`/api/works/${workId}/materials/${materialId}/replace`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ materialId: replacementId }),
    }),
  );
}

export async function fetchCompliance(workId: string, force = false): Promise<ComplianceReport> {
  if (USE_FIXTURES) return (await import('./fixtures')).fetchFixtureCompliance(workId, force);
  return ComplianceReportSchema.parse(
    await sendJson(`/api/works/${workId}/compliance?force=${String(force)}`),
  );
}

export async function attachMaterialLicense(
  workId: string,
  materialId: string,
  input: {
    evidenceType: 'commercial_use_grant' | 'license_document' | 'authorization_letter';
    evidenceUrl: string;
    expiresAt?: string;
  },
): Promise<AttachMaterialLicenseResponseData> {
  if (USE_FIXTURES) {
    return (await import('./fixtures')).attachFixtureMaterialLicense(workId, materialId, input);
  }
  return AttachMaterialLicenseResponse.parse(
    await sendJson(`/api/works/${workId}/materials/${materialId}/license`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(AttachMaterialLicenseRequest.parse(input)),
    }),
  );
}

export interface LibraryFilter {
  readonly q?: string;
  readonly type?: MaterialType;
  readonly license?: LicenseState;
}

export async function fetchLibrary(filter: LibraryFilter): Promise<{
  items: Material[];
  nextCursor: string | null;
  total: number;
}> {
  if (USE_FIXTURES) return (await import('./fixtures')).fetchFixtureLibrary(filter);
  const params = new URLSearchParams();
  if (filter.q != null && filter.q !== '') params.set('q', filter.q);
  if (filter.type != null) params.set('type', filter.type);
  if (filter.license != null) params.set('license', filter.license);
  params.set('limit', '100');
  const json = await sendJson(`/api/library?${params.toString()}`);
  const page = pageOf(MaterialSchema).parse(json);
  return { items: page.items, nextCursor: page.nextCursor, total: page.total ?? page.items.length };
}

export async function generateTopics(
  workId: string,
  materialIds: readonly string[],
): Promise<void> {
  if (USE_FIXTURES) {
    (await import('./fixtures')).startFixtureTopics(materialIds);
    return;
  }
  const body = GenerateTopicsRequest.parse({ materialIds });
  JobSchema.parse(
    await sendJson(`/api/works/${workId}/topics:generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

export async function fetchTopics(workId: string, batchIndex = 1): Promise<TopicBatch> {
  if (USE_FIXTURES) return (await import('./fixtures')).fetchFixtureTopics(batchIndex);
  return TopicBatchSchema.parse(await sendJson(`/api/works/${workId}/topics?batch=${batchIndex}`));
}

export async function rerollTopics(workId: string): Promise<number> {
  if (USE_FIXTURES) return (await import('./fixtures')).rerollFixtureTopics().batchIndex;
  const accepted = RerollAccepted.parse(
    await sendJson(`/api/works/${workId}/topics:reroll`, { method: 'POST' }),
  );
  return accepted.batchIndex;
}

export async function selectTopic(workId: string, topicId: string): Promise<WorkEnvelope> {
  if (USE_FIXTURES) return (await import('./fixtures')).selectFixtureTopic(workId, topicId);
  const body = SelectTopicRequest.parse({ topicId });
  return WorkEnvelopeSchema.parse(
    await sendJson(`/api/works/${workId}/topic:select`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

export async function generateScript(workId: string): Promise<void> {
  if (USE_FIXTURES) {
    (await import('./fixtures')).generateFixtureScript(workId);
    return;
  }
  JobSchema.parse(
    await sendJson(`/api/works/${workId}/script:generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(GenerateScriptRequest.parse({})),
    }),
  );
}

export async function fetchScript(workId: string): Promise<Script> {
  if (USE_FIXTURES) return (await import('./fixtures')).fetchFixtureScript(workId);
  return ScriptSchema.parse(await sendJson(`/api/works/${workId}/script`));
}

export interface PatchScriptInput {
  readonly baseVersion: number;
  readonly sections: readonly {
    kind: 'hook3s' | 'body' | 'outro';
    lines: readonly { id?: string; ord: number; text: string }[];
  }[];
}

export async function patchScript(
  workId: string,
  input: PatchScriptInput,
): Promise<PatchScriptResponse> {
  const body = PatchScriptRequest.parse(input);
  if (USE_FIXTURES) return (await import('./fixtures')).patchFixtureScript(workId, body);
  return PatchScriptResponse.parse(
    await sendJson(`/api/works/${workId}/script`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

export async function fetchStyleSamples(): Promise<StyleSample[]> {
  if (USE_FIXTURES) return (await import('./fixtures')).FIXTURE_STYLE_SAMPLES;
  return StyleSampleSchema.array().parse(await sendJson('/api/style-samples'));
}

export async function fetchStyleProfile(): Promise<StyleProfile> {
  if (USE_FIXTURES) return (await import('./fixtures')).FIXTURE_STYLE_PROFILE;
  return StyleProfileSchema.parse(await sendJson('/api/style-profile'));
}

export async function createStyleSample(input: {
  title: string;
  content: string;
  source: 'upload' | 'paste';
}): Promise<StyleSample> {
  if (USE_FIXTURES) return (await import('./fixtures')).createFixtureStyleSample(input);
  return StyleSampleSchema.parse(
    await sendJson('/api/style-samples', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  );
}

export async function restyleScript(
  workId: string,
  sampleIds: readonly string[],
): Promise<RestyleResponse> {
  if (USE_FIXTURES) return (await import('./fixtures')).restyleFixtureScript(workId);
  const body = RestyleRequest.parse({ sampleIds });
  const json = await sendJson(`/api/works/${workId}/script:restyle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return RestyleResponse.parse(json);
}

export async function resolveStyleHunk(
  workId: string,
  hunkId: string,
  accept: boolean,
): Promise<void> {
  if (USE_FIXTURES) {
    (await import('./fixtures')).resolveFixtureStyleHunk(workId, hunkId, accept);
    return;
  }
  await sendJson(`/api/works/${workId}/script/hunks/${hunkId}:${accept ? 'accept' : 'reject'}`, {
    method: 'POST',
  });
}

export async function confirmScript(workId: string): Promise<WorkEnvelope> {
  if (USE_FIXTURES) return (await import('./fixtures')).confirmFixtureScript(workId);
  return ConfirmScriptResponse.parse(
    await sendJson(`/api/works/${workId}/script:confirm`, { method: 'POST' }),
  ).envelope;
}

export async function unlockScript(workId: string): Promise<WorkEnvelope> {
  if (USE_FIXTURES) return (await import('./fixtures')).unlockFixtureScript(workId);
  return ConfirmScriptResponse.parse(
    await sendJson(`/api/works/${workId}/script:unlock`, { method: 'POST' }),
  ).envelope;
}

export interface RenderJobView {
  readonly job: Job;
  readonly videoUrl: string | null;
}

export async function startRender(
  workId: string,
  quality: 'draft' | 'hd',
): Promise<RenderAccepted> {
  if (USE_FIXTURES) return (await import('./fixtures')).startFixtureRender(workId, quality);
  return RenderAccepted.parse(
    await sendJson(`/api/works/${workId}/video:${quality}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(RenderRequest.parse({ quality })),
    }),
  );
}

export async function fetchRenderJob(jobId: string): Promise<RenderJobView> {
  if (USE_FIXTURES) return (await import('./fixtures')).fetchFixtureRenderJob(jobId);
  const json = await sendJson(`/api/jobs/${jobId}`);
  return {
    job: JobSchema.parse((json as { job: unknown }).job),
    videoUrl: (json as { videoUrl: string | null }).videoUrl,
  };
}

export async function cancelRenderJob(jobId: string): Promise<void> {
  if (USE_FIXTURES) {
    (await import('./fixtures')).cancelFixtureRenderJob(jobId);
    return;
  }
  JobSchema.parse(await sendJson(`/api/jobs/${jobId}:cancel`, { method: 'POST' }));
}

export async function retryRenderJob(workId: string, jobId: string): Promise<void> {
  if (USE_FIXTURES) {
    (await import('./fixtures')).retryFixtureRenderJob(workId, jobId);
    return;
  }
  RenderAccepted.parse(await sendJson(`/api/jobs/${jobId}:retry`, { method: 'POST' }));
}

export async function fetchQuota(): Promise<Quota> {
  if (USE_FIXTURES) return (await import('./fixtures')).FIXTURE_QUOTA;
  return QuotaSchema.parse(await sendJson('/api/quota'));
}

export async function fetchMetrics(): Promise<MetricsResponseData> {
  if (USE_FIXTURES) return (await import('./fixtures')).FIXTURE_METRICS;
  return MetricsResponse.parse(await sendJson('/api/metrics'));
}

export interface LedgerInput {
  readonly month: string;
  readonly cursor?: string;
}

export async function fetchLedger(input: LedgerInput): Promise<{
  items: LedgerEntry[];
  nextCursor: string | null;
  total: number;
}> {
  if (USE_FIXTURES) return (await import('./fixtures')).fetchFixtureLedger(input);
  const params = new URLSearchParams({ month: input.month, limit: '20' });
  if (input.cursor !== undefined) params.set('cursor', input.cursor);
  const page = pageOf(LedgerEntrySchema).parse(await sendJson(`/api/quota/ledger?${params}`));
  return { items: page.items, nextCursor: page.nextCursor, total: page.total ?? page.items.length };
}

export async function fetchPlatformRules(): Promise<PlatformRule[]> {
  if (USE_FIXTURES) return (await import('./fixtures')).FIXTURE_PLATFORM_RULES;
  return PlatformRuleSchema.array().parse(await sendJson('/api/platform-rules'));
}

export interface DerivativesView {
  readonly derivatives: Derivative[];
  readonly envelope: WorkEnvelope;
}

export async function fetchDerivatives(workId: string): Promise<DerivativesView> {
  if (USE_FIXTURES) return (await import('./fixtures')).fetchFixtureDerivatives(workId);
  return DerivativesResponse.parse(await sendJson(`/api/works/${workId}/derivatives`));
}

export async function generateDerivativeMetadata(workId: string): Promise<DerivativesView> {
  if (USE_FIXTURES) return (await import('./fixtures')).generateFixtureDerivatives(workId);
  return DerivativesResponse.parse(
    await sendJson(`/api/works/${workId}/derivatives:generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'metadata' }),
    }),
  );
}

export async function generateDerivativeMedia(workId: string): Promise<RenderAccepted> {
  if (USE_FIXTURES) {
    return (await import('./fixtures')).generateFixtureDerivativeMedia(workId);
  }
  return RenderAccepted.parse(
    await sendJson(`/api/works/${workId}/derivatives:generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'media' }),
    }),
  );
}

export async function patchDerivative(
  workId: string,
  platformId: PlatformId,
  input: { title?: string; tags?: string[]; durationVersion?: 'full' | 'essence30' | 'teaser15' },
): Promise<DerivativesView> {
  if (USE_FIXTURES) {
    return (await import('./fixtures')).patchFixtureDerivative(workId, platformId, input);
  }
  return DerivativesResponse.parse(
    await sendJson(`/api/works/${workId}/derivatives/${platformId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(PatchDerivativeRequest.parse(input)),
    }),
  );
}

export async function regenerateDerivativeTitle(
  workId: string,
  platformId: PlatformId,
): Promise<{ derivative: Derivative; envelope: WorkEnvelope }> {
  if (USE_FIXTURES) {
    return (await import('./fixtures')).regenerateFixtureDerivativeTitle(workId, platformId);
  }
  const json = await sendJson(`/api/works/${workId}/derivatives/${platformId}/title:regenerate`, {
    method: 'POST',
  });
  return {
    derivative: DerivativeSchema.parse((json as { derivative: unknown }).derivative),
    envelope: WorkEnvelopeSchema.parse((json as { envelope: unknown }).envelope),
  };
}

export async function createExport(workId: string): Promise<ExportAccepted> {
  if (USE_FIXTURES) return (await import('./fixtures')).createFixtureExport(workId);
  return ExportAccepted.parse(
    await sendJson(`/api/works/${workId}/export`, {
      method: 'POST',
    }),
  );
}

export async function fetchExportPackage(exportId: string): Promise<ExportPackage> {
  if (USE_FIXTURES) return (await import('./fixtures')).fetchFixtureExportPackage(exportId);
  return ExportPackageSchema.parse(await sendJson(`/api/exports/${exportId}`));
}
