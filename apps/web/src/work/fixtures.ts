import {
  CollectMaterialResponse,
  ComplianceReportSchema,
  DerivativeSchema,
  ExportAccepted,
  ExportFileSchema,
  ExportPackageSchema,
  JobSchema,
  LedgerEntrySchema,
  MaterialSourceConfigResponse,
  MaterialSourcesResponse,
  MetricsResponse,
  PlatformRuleSchema,
  PatchScriptResponse,
  RenderAccepted,
  RestyleResponse,
  ScriptSchema,
  SearchSessionSchema,
  StyleProfileSchema,
  StyleSampleSchema,
  TopicBatchSchema,
  WorkEnvelopeSchema,
} from '@knowstudio/contracts';
import type {
  Job,
  AttachMaterialLicenseResponse as AttachMaterialLicenseResponseData,
  ApiError,
  ComplianceReport,
  Derivative,
  ExportFile,
  ExportPackage,
  LedgerEntry,
  Material,
  MaterialSourceConfigRequest,
  MaterialSourceConfigTestResponse,
  MetricsResponse as MetricsResponseData,
  PlatformRule,
  PlatformId,
  Quota,
  SearchSession,
  Script,
  StyleProfile,
  StyleSample,
  StyleHunk,
  TopicBatch,
  WorkEnvelope,
  WorkListItem,
} from '@knowstudio/contracts';
import { resumePath } from '@knowstudio/domain';

/**
 * T-10（Work CRUD API）尚未交付，dev 下用信封 fixture 顶替服务端。
 * 形状与架构 §5.6 示例一致，并当场过一遍契约 schema：契约漂移在开发期就暴露，
 * 而不是等接上真 API 才发现前端读错字段。生产构建不会走到这里。
 * 禁用态的 parallelHint.redirectTo 也不能留空：契约按站内相对路径校验，空串会让整份信封 parse 失败。
 */
const FIXTURE_LIST: WorkEnvelope[] = [
  WorkEnvelopeSchema.parse({
    id: 'w1',
    title: '费曼学习法：为什么你学了就忘',
    keyword: '费曼学习法',
    phase: 2,
    step: 'video.rendering',
    progress: 70,
    gates: { G1: true, G2: true, G3: false, G4: false },
    gateDetails: {
      G3: {
        satisfied: false,
        reason: 'HD_RENDER_NOT_SUCCEEDED',
        redirectTo: '/studio/w1/render',
        activeJobId: 'job_88',
      },
      G4: {
        satisfied: false,
        reason: 'COMPLIANCE_REPORT_MISSING',
        redirectTo: '/publish/w1',
      },
    },
    selectedTopicId: 't_03',
    scriptConfirmedAt: '2026-11-12T10:12:03Z',
    activeRenderJobId: 'job_88',
    parallelHint: {
      enabled: true,
      cta: '渲染时你可以先去写平台标题',
      redirectTo: '/publish/w1',
    },
    quota: { total: 60, used: 22, reserved: 2, left: 36, resetAt: '2026-12-01T00:00:00Z' },
  }),
  WorkEnvelopeSchema.parse({
    id: 'w2',
    title: '间隔重复：把遗忘曲线变成复习表',
    keyword: '间隔重复',
    phase: 1,
    step: 'script',
    progress: 50,
    gates: { G1: true, G2: false, G3: false, G4: false },
    gateDetails: {
      G2: { satisfied: false, reason: 'SCRIPT_NOT_CONFIRMED', redirectTo: '/studio/w2/script' },
      G3: { satisfied: false, reason: 'HD_RENDER_NOT_SUCCEEDED', redirectTo: '/studio/w2/video' },
      G4: {
        satisfied: false,
        reason: 'COMPLIANCE_REPORT_MISSING',
        redirectTo: '/publish/w2',
      },
    },
    selectedTopicId: 't07',
    scriptConfirmedAt: null,
    activeRenderJobId: null,
    parallelHint: { enabled: false, cta: '', redirectTo: resumePath('script', 'w2') },
    quota: { total: 60, used: 20, reserved: 0, left: 40, resetAt: '2026-12-01T00:00:00Z' },
  }),
  WorkEnvelopeSchema.parse({
    id: 'w3',
    title: '刻意练习：为什么练一万小时还不够',
    keyword: '刻意练习',
    phase: 3,
    step: 'export',
    progress: 95,
    gates: { G1: true, G2: true, G3: true, G4: true },
    gateDetails: {},
    selectedTopicId: 't11',
    scriptConfirmedAt: '2026-11-11T09:00:00Z',
    activeRenderJobId: null,
    parallelHint: { enabled: false, cta: '', redirectTo: resumePath('export', 'w3') },
    quota: { total: 60, used: 24, reserved: 0, left: 36, resetAt: '2026-12-01T00:00:00Z' },
  }),
];

export const FIXTURE_WORKS = new Map(FIXTURE_LIST.map((w) => [w.id, w]));

export const FIXTURE_RECENT: WorkListItem = {
  id: 'w1',
  title: '费曼学习法：为什么你学了就忘',
  keyword: '费曼学习法',
  phase: 2,
  step: 'video.rendering',
  progress: 70,
  gates: { G1: true, G2: true, G3: false, G4: false },
  updatedAt: '2026-11-12T10:20:00Z',
};

const FIXTURE_MATERIAL_SOURCES = MaterialSourcesResponse.parse({
  items: [
    { id: 'recorded', name: '录制演示', description: '内置素材。', configured: true },
    { id: 'web_search', name: 'Web 搜索', description: '真实 API 未启用。', configured: false },
    { id: 'obsidian', name: 'Obsidian', description: 'MCP 未启用。', configured: false },
  ],
});

export const FIXTURE_QUOTA: Quota = {
  total: 60,
  used: 22,
  reserved: 2,
  left: 36,
  resetAt: '2026-12-01T00:00:00Z',
};

export const FIXTURE_METRICS: MetricsResponseData = MetricsResponse.parse({
  items: [
    {
      metric: 'g1_e2e_p50',
      value: 42.5,
      sampleN: 6,
      bucket: '2026-11-17T00:00:00Z',
      computedAt: '2026-11-17T00:10:00Z',
    },
    {
      metric: 'g3_polish_p50',
      value: 8.2,
      sampleN: 6,
      bucket: '2026-11-17T00:00:00Z',
      computedAt: '2026-11-17T00:10:00Z',
    },
    {
      metric: 'g5_platform_coverage',
      value: 4,
      sampleN: 4,
      bucket: '2026-11-17T00:00:00Z',
      computedAt: '2026-11-17T00:10:00Z',
    },
    {
      metric: 'g6_cost_per_work',
      value: 2.8,
      sampleN: 6,
      bucket: '2026-11-17T00:00:00Z',
      computedAt: '2026-11-17T00:10:00Z',
    },
  ],
  fresh: true,
  dataStatus: 'fresh',
  generatedAt: '2026-11-17T00:10:00Z',
  expectedBucket: '2026-11-17T00:00:00Z',
  task: {
    bucket: '2026-11-17T00:00:00Z',
    status: 'succeeded',
    state: 'done',
    attempt: 1,
    maxAttempt: 3,
    startedAt: '2026-11-17T00:09:58Z',
    finishedAt: '2026-11-17T00:10:01Z',
    durationMs: 3000,
    runAfter: '2026-11-17T00:00:00Z',
    lastError: null,
  },
  g4BlindTest: { source: 'manual', value: null },
});

const LEDGER_ITEMS = LedgerEntrySchema.array().parse([
  {
    id: 11,
    workId: 'w1',
    jobId: 'job_hd_w1',
    action: 'reserve',
    points: 2,
    balanceAfter: 36,
    note: '渲染预扣',
    createdAt: '2026-11-16T07:20:00Z',
  },
  {
    id: 10,
    workId: 'w1',
    jobId: 'job_hd_w1',
    action: 'commit',
    points: 2,
    balanceAfter: 36,
    note: '渲染完成',
    createdAt: '2026-11-16T07:21:00Z',
  },
  {
    id: 9,
    workId: 'w3',
    jobId: null,
    action: 'commit',
    points: 2,
    balanceAfter: 36,
    note: '高清渲染结算 2 点/条',
    createdAt: '2026-11-14T08:00:00Z',
  },
]);

export function fetchFixtureLedger(input: { month: string }): {
  items: LedgerEntry[];
  nextCursor: null;
  total: number;
} {
  const items = LEDGER_ITEMS.filter((item) => item.createdAt.startsWith(input.month));
  return { items, nextCursor: null, total: items.length };
}

export const FIXTURE_PLATFORM_RULES: PlatformRule[] = PlatformRuleSchema.array().parse([
  {
    platformId: 'bili',
    version: 1,
    name: 'B站',
    ratio: '16:9',
    isCurrent: true,
    titleMax: 80,
    titleHardMax: 160,
    tagMax: 4,
    maxDurationSec: 90,
    orient: 'horizontal',
    brandColor: '#00a1d6',
    styleHint: '深入·干货',
    bannedPatterns: [],
    updatedAt: '2026-11-13T00:00:00Z',
  },
  {
    platformId: 'douyin',
    version: 1,
    name: '抖音',
    ratio: '9:16',
    isCurrent: true,
    titleMax: 30,
    titleHardMax: 60,
    tagMax: 4,
    maxDurationSec: 60,
    orient: 'vertical',
    brandColor: '#fe2c55',
    styleHint: '情绪强·节奏快',
    bannedPatterns: [],
    updatedAt: '2026-11-13T00:00:00Z',
  },
  {
    platformId: 'sph',
    version: 1,
    name: '视频号',
    ratio: '9:16',
    isCurrent: true,
    titleMax: 30,
    titleHardMax: 60,
    tagMax: 3,
    maxDurationSec: 60,
    orient: 'vertical',
    brandColor: '#07c160',
    styleHint: '稳重·可信',
    bannedPatterns: [],
    updatedAt: '2026-11-13T00:00:00Z',
  },
  {
    platformId: 'xhs',
    version: 1,
    name: '小红书',
    ratio: '9:16',
    isCurrent: true,
    titleMax: 30,
    titleHardMax: 60,
    tagMax: 4,
    maxDurationSec: 60,
    orient: 'vertical',
    brandColor: '#ff2442',
    styleHint: '亲和·种草',
    bannedPatterns: [],
    updatedAt: '2026-11-13T00:00:00Z',
  },
]);

const FIXTURE_KNOWLEDGE: Material[] = [
  {
    id: 'mat_k1',
    type: 'knowledge',
    title: '费曼学习法：用输出倒逼输入',
    summary: '把学到的东西用简单的话讲出来，讲不清楚的地方就是没懂的地方。',
    source: '知乎',
    url: null,
    license: 'cleared',
    collected: true,
  },
  {
    id: 'mat_k2',
    type: 'knowledge',
    title: '为什么重复阅读是最低效的学习',
    summary: '熟悉感常被误当成理解，提取练习才是更有效的记忆方式。',
    source: '公众号',
    url: null,
    license: 'restricted',
    collected: false,
  },
  {
    id: 'mat_k3',
    type: 'knowledge',
    title: '认知天性·检索练习摘录',
    summary: '检索练习迫使大脑重建知识，而不是被动地重新识别。',
    source: '书籍《认知天性》',
    url: null,
    license: 'restricted',
    collected: false,
  },
  {
    id: 'mat_k4',
    type: 'knowledge',
    title: '把知识讲给外行听的四个步骤',
    summary: '选概念、讲给外行、定位卡点、简化重讲，构成一个闭环。',
    source: '知乎',
    url: null,
    license: 'cleared',
    collected: false,
  },
];

const FIXTURE_HOT: Material[] = [
  {
    id: 'mat_h1',
    type: 'hot',
    title: '假装努力',
    summary: '24 小时上升期热点，适合与学习方法论结合。',
    source: '抖音',
    url: null,
    license: 'unknown',
    collected: true,
  },
  {
    id: 'mat_h2',
    type: 'hot',
    title: '期末复习',
    summary: '热点仍有关注度，但已过峰值。',
    source: 'B站',
    url: null,
    license: 'unknown',
    collected: false,
  },
  {
    id: 'mat_h3',
    type: 'hot',
    title: '技能焦虑',
    summary: '12 小时上升期热点，适合切入职场学习场景。',
    source: '微博',
    url: null,
    license: 'unknown',
    collected: false,
  },
];

const FIXTURE_PEER: Material[] = [
  {
    id: 'mat_p1',
    type: 'peer',
    title: '三分钟讲透费曼学习法',
    summary: '抖音 52 万赞，结构是概念、步骤、案例、行动。',
    source: '抖音',
    url: null,
    license: 'unknown',
    collected: false,
  },
  {
    id: 'mat_p2',
    type: 'peer',
    title: '我是怎么靠讲故事学会物理的',
    summary: 'B站 180 万播放，故事化表达强，方法论略散。',
    source: 'B站',
    url: null,
    license: 'unknown',
    collected: false,
  },
  {
    id: 'mat_p3',
    type: 'peer',
    title: '费曼学习法模板直接抄',
    summary: '小红书 8 万收藏，工具化表达，缺少原理拆解。',
    source: '小红书',
    url: null,
    license: 'unknown',
    collected: false,
  },
];

const FIXTURE_SEARCH_ID = 'ss_fixture_feynman';
const FIXTURE_EMPTY_SEARCH_ID = 'ss_fixture_empty';

const FIXTURE_DERIVATIVES = new Map<string, Derivative[]>();

function fixtureDerivativesFor(workId: string): Derivative[] {
  const work = FIXTURE_WORKS.get(workId);
  if (work === undefined) throw new Error(`占位数据里没有作品 ${workId}`);
  return FIXTURE_DERIVATIVES.get(workId) ?? [];
}

function derivativeEnvelope(workId: string): WorkEnvelope {
  const work = FIXTURE_WORKS.get(workId);
  if (work === undefined) throw new Error(`占位数据里没有作品 ${workId}`);
  const updated = WorkEnvelopeSchema.parse({
    ...work,
    step: 'derive',
    phase: 3,
    progress: 90,
  });
  FIXTURE_WORKS.set(workId, updated);
  return updated;
}

export function fetchFixtureDerivatives(workId: string): {
  derivatives: Derivative[];
  envelope: WorkEnvelope;
} {
  return { derivatives: fixtureDerivativesFor(workId), envelope: derivativeEnvelope(workId) };
}

export function generateFixtureDerivatives(workId: string): {
  derivatives: Derivative[];
  envelope: WorkEnvelope;
} {
  const work = FIXTURE_WORKS.get(workId);
  if (work === undefined) throw new Error(`占位数据里没有作品 ${workId}`);
  const titleByPlatform: Record<PlatformId, string> = {
    bili: '费曼学习法：把知识真正讲懂',
    douyin: '别再死记硬背了',
    sph: '为什么你学了就忘',
    xhs: '费曼学习法｜收藏版',
  };
  const rows = FIXTURE_PLATFORM_RULES.map((rule) =>
    DerivativeSchema.parse({
      id: `dv_${workId}_${rule.platformId}`,
      workId,
      platformId: rule.platformId,
      title: titleByPlatform[rule.platformId],
      tags: rule.platformId === 'bili' ? ['费曼学习法', '知识科普'] : ['学习方法', '费曼技巧'],
      durationVersion: rule.platformId === 'douyin' ? 'essence30' : 'full',
      coverLayerId: null,
      videoAssetId: null,
      mediaUrl: null,
      ruleVersion: rule.version,
      metadataReady: true,
      mediaReady: false,
      validation: [],
    }),
  );
  FIXTURE_DERIVATIVES.set(workId, rows);
  return { derivatives: rows, envelope: derivativeEnvelope(workId) };
}

export function patchFixtureDerivative(
  workId: string,
  platformId: PlatformId,
  input: { title?: string; tags?: string[]; durationVersion?: 'full' | 'essence30' | 'teaser15' },
): { derivatives: Derivative[]; envelope: WorkEnvelope } {
  const rows = fixtureDerivativesFor(workId).map((row) =>
    row.platformId === platformId
      ? DerivativeSchema.parse({
          ...row,
          title: input.title ?? row.title,
          tags: input.tags ?? row.tags,
          durationVersion: input.durationVersion ?? row.durationVersion,
        })
      : row,
  );
  FIXTURE_DERIVATIVES.set(workId, rows);
  return { derivatives: rows, envelope: derivativeEnvelope(workId) };
}

export function regenerateFixtureDerivativeTitle(
  workId: string,
  platformId: PlatformId,
): { derivative: Derivative; envelope: WorkEnvelope } {
  const rows = fixtureDerivativesFor(workId);
  const current = rows.find((row) => row.platformId === platformId);
  if (current === undefined) throw new Error('DERIVATIVE_NOT_FOUND');
  const derivative = DerivativeSchema.parse({
    ...current,
    title: `${current.title}｜升级版`,
  });
  FIXTURE_DERIVATIVES.set(
    workId,
    rows.map((row) => (row.platformId === platformId ? derivative : row)),
  );
  return { derivative, envelope: derivativeEnvelope(workId) };
}

export function generateFixtureDerivativeMedia(workId: string): RenderAccepted {
  const rows = fixtureDerivativesFor(workId).map((row) =>
    DerivativeSchema.parse({
      ...row,
      coverLayerId: `al_cover_${row.platformId}`,
      videoAssetId: `va_${row.platformId}_${workId}`,
      mediaReady: true,
      mediaUrl: '/fixture-video.mp4',
    }),
  );
  FIXTURE_DERIVATIVES.set(workId, rows);
  const now = new Date().toISOString();
  const jobId = `job_derive_media_${workId}`;
  FIXTURE_RENDER_JOBS.set(jobId, {
    job: {
      id: jobId,
      workId,
      type: 'derive_media',
      status: 'succeeded',
      stage: 'finalize',
      progress: 100,
      costPoints: 0,
      reservationId: null,
      attempt: 0,
      error: null,
      createdAt: now,
      updatedAt: now,
    },
    videoUrl: null,
  });
  return RenderAccepted.parse({
    jobId,
    costPoints: 0,
    reservationId: null,
    quota: FIXTURE_QUOTA,
    sseUrl: `/api/jobs/${jobId}/events`,
  });
}

const FIXTURE_EXPORT_PACKAGES = new Map<string, ExportPackage>();

function fixtureExportFiles(exportId: string, workId: string): ExportFile[] {
  const platformFiles = (['douyin', 'sph', 'bili', 'xhs'] as const).flatMap((platformId) => [
    ExportFileSchema.parse({
      platformId,
      kind: 'video',
      key: `exports/${workId}/${exportId}/${platformId}/video.mp4`,
      path: `${platformId}/video.mp4`,
      url: '/fixture-video.mp4',
      bytes: 1024,
      durationMs: 180_000,
    }),
    ExportFileSchema.parse({
      platformId,
      kind: 'cover',
      key: `exports/${workId}/${exportId}/${platformId}/cover.svg`,
      path: `${platformId}/cover.svg`,
      url: '/fixture-cover.svg',
      bytes: 2048,
      durationMs: null,
    }),
  ]);
  return [
    ...platformFiles,
    ExportFileSchema.parse({
      platformId: null,
      kind: 'manifest',
      key: `exports/${workId}/${exportId}/manifest.json`,
      path: 'manifest.json',
      url: `/api/local-storage/exports/${workId}/${exportId}/manifest.json`,
      bytes: 4096,
      durationMs: null,
    }),
    ExportFileSchema.parse({
      platformId: null,
      kind: 'checklist',
      key: `exports/${workId}/${exportId}/publish-checklist.md`,
      path: '发布清单.md',
      url: `/api/local-storage/exports/${workId}/${exportId}/publish-checklist.md`,
      bytes: 8192,
      durationMs: null,
    }),
    ExportFileSchema.parse({
      platformId: null,
      kind: 'package',
      key: `exports/${workId}/${exportId}/package.zip`,
      path: 'package.zip',
      url: `/api/local-storage/exports/${workId}/${exportId}/package.zip`,
      bytes: 1_048_576,
      durationMs: null,
    }),
  ];
}

export function createFixtureExport(workId: string): ExportAccepted {
  const work = FIXTURE_WORKS.get(workId);
  if (work === undefined) throw new Error(`占位数据里没有作品 ${workId}`);
  const report = fixtureCompliance(workId, true);
  if (report.blockingCount > 0) {
    const error = new Error('合规检查存在阻断项') as Error & { apiError: ApiError };
    error.apiError = {
      code: 'COMPLIANCE_BLOCKED',
      message: '合规检查存在阻断项，先完成修复再导出',
      details: {
        reportId: report.id,
        blockingItems: report.items.filter((item) => item.blocking),
      },
    };
    throw error;
  }

  if (fixtureDerivativesFor(workId).length === 0) generateFixtureDerivatives(workId);
  generateFixtureDerivativeMedia(workId);
  const rows = fixtureDerivativesFor(workId);
  if (rows.length !== 4 || rows.some((row) => !row.mediaReady)) {
    throw new Error('EXPORT_MEDIA_NOT_READY');
  }

  const exportId = `exp_fixture_${workId}`.slice(0, 36);
  FIXTURE_EXPORT_PACKAGES.set(
    exportId,
    ExportPackageSchema.parse({
      id: exportId,
      workId,
      status: 'queued',
      files: [],
      reportId: report.id,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
      createdAt: new Date().toISOString(),
    }),
  );
  return ExportAccepted.parse({ exportId });
}

export function fetchFixtureExportPackage(exportId: string): ExportPackage {
  const current = FIXTURE_EXPORT_PACKAGES.get(exportId);
  if (current === undefined) throw new Error('EXPORT_NOT_FOUND');
  if (current.status === 'succeeded') return current;
  const status = current.status === 'queued' ? 'running' : 'succeeded';
  const updated = ExportPackageSchema.parse({
    ...current,
    status,
    files: status === 'succeeded' ? fixtureExportFiles(current.id, current.workId) : [],
  });
  FIXTURE_EXPORT_PACKAGES.set(exportId, updated);
  return updated;
}

const FIXTURE_KEYWORD = '费曼学习法';
const FIXTURE_COLLECTED = new Set(['mat_k1', 'mat_h1']);
const FIXTURE_LIBRARY_MATERIALS: Material[] = [
  ...FIXTURE_KNOWLEDGE,
  ...FIXTURE_HOT,
  ...FIXTURE_PEER,
];

function fixtureSession(keyword: string, materials: Material[], cacheHit: boolean): SearchSession {
  return SearchSessionSchema.parse({
    id: materials.length === 0 ? FIXTURE_EMPTY_SEARCH_ID : FIXTURE_SEARCH_ID,
    keyword,
    status: 'succeeded',
    materials: materials.map((m) => ({ ...m, collected: FIXTURE_COLLECTED.has(m.id) })),
    saturation:
      materials.length === 0
        ? null
        : {
            score: 72,
            level: 'saturated',
            confidence: 0.86,
            sampleSize: 10,
            coveredPlatforms: ['douyin', 'sph', 'bili', 'xhs'],
            sources: ['知乎', '公众号', '抖音', 'B站', '微博', '小红书'],
            sufficient: true,
          },
    blankAngles:
      materials.length === 0
        ? []
        : [
            {
              id: 'ba_1',
              label: '费曼 × 职场汇报',
              basisMaterialIds: ['mat_k1'],
              rationale: '学习法还没迁移到把方案讲清楚的高频职场场景。',
            },
            {
              id: 'ba_2',
              label: '费曼 × 假装努力',
              basisMaterialIds: ['mat_h1', 'mat_k1'],
              rationale: '热点情绪和方法论之间缺少可执行的判断标准。',
            },
            {
              id: 'ba_3',
              label: '费曼 × 卡片笔记',
              basisMaterialIds: ['mat_k4'],
              rationale: '笔记工具只负责收集，缺少向外输出的闭环。',
            },
          ],
    partialErrors: [],
    cacheHit,
    createdAt: '2026-11-16T10:00:00.000Z',
  });
}

const FIXTURE_SEARCH_SESSIONS = new Map<string, SearchSession>([
  [
    FIXTURE_SEARCH_ID,
    fixtureSession(FIXTURE_KEYWORD, [...FIXTURE_KNOWLEDGE, ...FIXTURE_HOT, ...FIXTURE_PEER], false),
  ],
  [FIXTURE_EMPTY_SEARCH_ID, fixtureSession('未录制关键词', [], false)],
]);

export type FixtureSearchStart =
  | { readonly kind: 'session'; readonly session: SearchSession }
  | { readonly kind: 'accepted'; readonly searchId: string };

export function startFixtureSearch(input: {
  readonly keyword: string;
  readonly force?: boolean;
  readonly sources?: readonly string[];
}): FixtureSearchStart {
  const normalized = input.keyword.trim().normalize('NFKC').toLowerCase();
  const session =
    normalized === FIXTURE_KEYWORD.normalize('NFKC').toLowerCase()
      ? FIXTURE_SEARCH_SESSIONS.get(FIXTURE_SEARCH_ID)
      : FIXTURE_SEARCH_SESSIONS.get(FIXTURE_EMPTY_SEARCH_ID);
  if (session === undefined) throw new Error('fixture search missing');
  if (!input.force) return { kind: 'session', session: { ...session, cacheHit: true } };
  return { kind: 'accepted', searchId: session.id };
}

export function fetchFixtureMaterialSources(): MaterialSourcesResponse {
  return FIXTURE_MATERIAL_SOURCES;
}

let fixtureConfig = MaterialSourceConfigResponse.parse({
  webSearch: {
    enabled: false,
    apiKeyLast4: null,
    maxResults: 5,
    testedAt: null,
    updatedAt: null,
  },
  obsidian: {
    enabled: false,
    endpoint: null,
    tool: null,
    timeoutMs: 8000,
    maxResults: 5,
    testedAt: null,
    updatedAt: null,
  },
});

export function fetchFixtureMaterialSourceConfig(): MaterialSourceConfigResponse {
  return fixtureConfig;
}

export function updateFixtureMaterialSourceConfig(
  input: MaterialSourceConfigRequest,
): MaterialSourceConfigResponse {
  const now = new Date().toISOString();
  fixtureConfig = MaterialSourceConfigResponse.parse({
    webSearch: {
      ...fixtureConfig.webSearch,
      enabled: input.webSearch?.enabled ?? fixtureConfig.webSearch.enabled,
      apiKeyLast4:
        input.webSearch?.apiKey === undefined
          ? fixtureConfig.webSearch.apiKeyLast4
          : input.webSearch.apiKey.slice(-4),
      maxResults: input.webSearch?.maxResults ?? fixtureConfig.webSearch.maxResults,
      updatedAt: now,
    },
    obsidian: {
      ...fixtureConfig.obsidian,
      enabled: input.obsidian?.enabled ?? fixtureConfig.obsidian.enabled,
      endpoint: input.obsidian?.endpoint ?? fixtureConfig.obsidian.endpoint,
      tool: input.obsidian?.tool ?? fixtureConfig.obsidian.tool,
      timeoutMs: input.obsidian?.timeoutMs ?? fixtureConfig.obsidian.timeoutMs,
      maxResults: input.obsidian?.maxResults ?? fixtureConfig.obsidian.maxResults,
      updatedAt: now,
    },
  });
  return fixtureConfig;
}

export function testFixtureMaterialSource(
  sourceId: 'web_search' | 'obsidian',
): MaterialSourceConfigTestResponse {
  return { sourceId, ok: false, latencyMs: 0, error: 'fixture 模式不访问外部服务' };
}

export function fetchFixtureSearchSession(searchId: string): SearchSession {
  const session = FIXTURE_SEARCH_SESSIONS.get(searchId);
  if (session === undefined) throw new Error(`占位数据里没有搜索 ${searchId}`);
  return {
    ...session,
    materials: session.materials.map((m) => ({ ...m, collected: FIXTURE_COLLECTED.has(m.id) })),
  };
}

export function fetchFixtureLibrary(filter: {
  q?: string;
  type?: Material['type'];
  license?: Material['license'];
}): { items: Material[]; nextCursor: null; total: number } {
  const q = filter.q?.trim().toLowerCase();
  const items = FIXTURE_LIBRARY_MATERIALS.filter((material) => {
    if (q != null && !material.title.toLowerCase().includes(q)) return false;
    if (filter.type != null && material.type !== filter.type) return false;
    if (filter.license != null && material.license !== filter.license) return false;
    return true;
  }).map((material) => ({ ...material, collected: FIXTURE_COLLECTED.has(material.id) }));
  return { items, nextCursor: null, total: items.length };
}

export function collectFixtureMaterial(
  workId: string,
  materialId: string,
  collected: boolean,
): CollectMaterialResponse {
  if (collected) FIXTURE_COLLECTED.add(materialId);
  else FIXTURE_COLLECTED.delete(materialId);
  const envelope = FIXTURE_WORKS.get(workId) ?? FIXTURE_WORKS.get('w1');
  if (envelope === undefined) throw new Error(`占位数据里没有作品 ${workId}`);
  return CollectMaterialResponse.parse({
    collectedCount: FIXTURE_COLLECTED.size,
    envelope,
    patchJob: null,
  });
}

export function replaceFixtureMaterial(
  workId: string,
  materialId: string,
  replacementId: string,
): CollectMaterialResponse {
  FIXTURE_COLLECTED.delete(materialId);
  FIXTURE_COLLECTED.add(replacementId);
  const envelope = FIXTURE_WORKS.get(workId) ?? FIXTURE_WORKS.get('w1');
  if (envelope === undefined) throw new Error(`占位数据里没有作品 ${workId}`);
  return CollectMaterialResponse.parse({
    collectedCount: FIXTURE_COLLECTED.size,
    envelope,
    patchJob: null,
  });
}

function fixtureCompliance(workId: string, force = false): ComplianceReport {
  const work = FIXTURE_WORKS.get(workId);
  if (work === undefined) throw new Error(`占位数据里没有作品 ${workId}`);
  const blocked = FIXTURE_LIBRARY_MATERIALS.filter(
    (material) => FIXTURE_COLLECTED.has(material.id) && material.license !== 'cleared',
  );
  const report = ComplianceReportSchema.parse({
    id: `cr_${workId}_${force ? 'force' : 'cached'}`,
    workId,
    items: [
      {
        kind: 'image',
        status: 'pass',
        detail: '当前未引用图片素材。',
        blocking: false,
        materialIds: [],
      },
      {
        kind: 'music',
        status: 'pass',
        detail: '当前未引用音乐素材。',
        blocking: false,
        materialIds: [],
      },
      {
        kind: 'font',
        status: 'pass',
        detail: '模板使用思源黑体。',
        blocking: false,
        materialIds: [],
      },
      {
        kind: 'content',
        status: blocked.length === 0 ? 'pass' : 'block',
        detail:
          blocked.length === 0
            ? '文案与平台派生内容未命中受限词或原文搬运。'
            : `素材授权不可用：${blocked.map((material) => material.title).join('、')}`,
        blocking: blocked.length > 0,
        materialIds: blocked.map((material) => material.id),
        fixHint: '移除引用素材，替换素材，或绑定商用授权凭证。',
      },
    ],
    blockingCount: blocked.length === 0 ? 0 : 1,
    warnCount: 0,
    fingerprint: `fixture-${workId}-${blocked.map((material) => material.id).join(',')}`
      .padEnd(64, '0')
      .slice(0, 64),
    checkedAt: new Date().toISOString(),
  });
  const gateDetails = { ...work.gateDetails };
  if (report.blockingCount === 0) delete gateDetails.G4;
  else {
    gateDetails.G4 = {
      satisfied: false,
      reason: 'COMPLIANCE_BLOCKING',
      redirectTo: `/publish/${workId}`,
    };
  }
  const updated = WorkEnvelopeSchema.parse({
    ...work,
    gates: { ...work.gates, G4: report.blockingCount === 0 },
    gateDetails,
  });
  FIXTURE_WORKS.set(workId, updated);
  return report;
}

export function fetchFixtureCompliance(workId: string, force = false): ComplianceReport {
  return fixtureCompliance(workId, force);
}

export function attachFixtureMaterialLicense(
  workId: string,
  materialId: string,
  input: { evidenceUrl: string },
): AttachMaterialLicenseResponseData {
  const material = FIXTURE_LIBRARY_MATERIALS.find((item) => item.id === materialId);
  if (material === undefined || !FIXTURE_COLLECTED.has(materialId)) {
    throw new Error('COMPLIANCE_MATERIAL_NOT_REFERENCED');
  }
  material.license = 'cleared';
  material.summary = `已绑定授权凭证：${input.evidenceUrl}`;
  return {
    materialId,
    report: fixtureCompliance(workId, true),
    envelope: FIXTURE_WORKS.get(workId)!,
  };
}

export function createFixtureWork(keyword: string): WorkEnvelope {
  const id = `w_${keyword.replace(/[^a-z0-9-_]/gi, '').slice(0, 20) || 'new'}`;
  const created = WorkEnvelopeSchema.parse({
    id,
    title: keyword,
    keyword,
    phase: 0,
    step: 'search',
    progress: 15,
    gates: { G1: false, G2: false, G3: false, G4: false },
    gateDetails: {
      G1: { satisfied: false, reason: 'TOPIC_NOT_SELECTED', redirectTo: '/discover/topics' },
      G2: { satisfied: false, reason: 'SCRIPT_NOT_CONFIRMED', redirectTo: `/studio/${id}/script` },
      G3: {
        satisfied: false,
        reason: 'HD_RENDER_NOT_SUCCEEDED',
        redirectTo: `/studio/${id}/video`,
      },
      G4: { satisfied: false, reason: 'COMPLIANCE_REPORT_MISSING', redirectTo: `/publish/${id}` },
    },
    selectedTopicId: null,
    scriptConfirmedAt: null,
    activeRenderJobId: null,
    parallelHint: { enabled: false, cta: '', redirectTo: `/studio/${id}/script` },
    quota: FIXTURE_QUOTA,
  });
  FIXTURE_WORKS.set(id, created);
  return created;
}

const topicFixture = (suffix: '' | '_reroll') =>
  [
    '为什么你学了就忘？大脑在骗你',
    '费曼学习法：把知识讲成人话',
    '你以为的懂，只是认得',
    '学完就忘，是因为你从没输出过',
    '讲给外行听，是最狠的自测',
    '卡壳的那一句，才是你的漏洞',
    '费曼×职场汇报：把方案讲清楚',
    '费曼×假装努力：你在表演学习',
    '费曼×卡片笔记：把书读成自己的',
    '一天讲一个概念，30 天后变了',
    '为什么学霸都在用这套方法',
    '把知识翻译成人话的能力，值多少钱',
  ].map((hook, index) => ({
    id: `t_${String(index + 1).padStart(2, '0')}${suffix}`,
    batchId: `tb_fixture${suffix}`,
    hook: suffix === '' ? hook : `${hook}（换一批 ${index + 1}）`,
    gap: suffix === '' ? '熟悉感被误当成理解' : '换个证据链再讲一遍',
    basisMaterialIds: [FIXTURE_LIBRARY_MATERIALS[index % 3]?.id ?? 'mat_k1'],
    hookFingerprint: `fp_${suffix}_${index}`,
  }));

const FIXTURE_TOPIC_BATCHES = [1, 2].map((batchIndex) =>
  TopicBatchSchema.parse({
    id: batchIndex === 1 ? 'tb_fixture' : 'tb_fixture_reroll',
    workId: 'w1',
    batchIndex,
    topics: topicFixture(batchIndex === 1 ? '' : '_reroll'),
    requestedCount: 12,
    minPairwiseCosine: 0,
  }),
);

export function startFixtureTopics(materialIds: readonly string[]): Job {
  if (materialIds.length === 0 || materialIds.some((id) => !FIXTURE_COLLECTED.has(id))) {
    throw new Error('TOPIC_MATERIAL_NOT_COLLECTED');
  }
  return JobSchema.parse({
    id: 'tb_fixture',
    workId: 'w1',
    type: 'topics',
    status: 'succeeded',
    stage: null,
    progress: 100,
    costPoints: 0,
    reservationId: null,
    attempt: 0,
    error: null,
    createdAt: '2026-11-16T10:00:00.000Z',
    updatedAt: '2026-11-16T10:00:00.000Z',
  });
}

export function fetchFixtureTopics(batchIndex = 1): TopicBatch {
  return FIXTURE_TOPIC_BATCHES[batchIndex - 1] ?? FIXTURE_TOPIC_BATCHES[0]!;
}

export function rerollFixtureTopics(): {
  batchId: string;
  batchIndex: number;
  status: Job['status'];
} {
  return { batchId: 'tb_fixture_reroll', batchIndex: 2, status: 'succeeded' };
}

export function selectFixtureTopic(workId: string, topicId: string): WorkEnvelope {
  const current = FIXTURE_WORKS.get(workId) ?? FIXTURE_WORKS.get('w1');
  if (current === undefined) throw new Error(`占位数据里没有作品 ${workId}`);
  if (!topicId.startsWith('t_')) throw new Error('TOPIC_NOT_FOUND');
  const gateDetails = { ...current.gateDetails };
  delete gateDetails.G1;
  gateDetails.G2 = {
    satisfied: false,
    reason: 'SCRIPT_NOT_CONFIRMED',
    redirectTo: `/studio/${workId}/script`,
  };
  const updated = WorkEnvelopeSchema.parse({
    ...current,
    step: 'script',
    phase: 1,
    selectedTopicId: topicId,
    gates: { ...current.gates, G1: true, G2: false },
    gateDetails,
  });
  FIXTURE_WORKS.set(workId, updated);
  return updated;
}

const FIXTURE_SCRIPT_TEXT = [
  '你有没有过这种经历：书看了三遍，一合上就想不起来。',
  '不是你笨，是你一直在用错误的方式学习。',
  '费曼学习法的核心只有一句话：能用大白话讲清楚，才算学会。',
  '第一步，选一个概念，写在纸的最上面。',
  '第二步，假装讲给完全不懂的人听，不许用术语。',
  '第三步，卡住的地方就是漏洞，回去重看资料。',
  '第四步，把讲稿改得更简单，再讲一遍。',
  '今晚就挑一个概念，讲给自己听一遍。',
  '评论区告诉我你卡在哪一步，关注我，下期讲怎么补。',
];

const FIXTURE_SCRIPTS = new Map<string, Script>();

function fixtureScript(workId: string): Script {
  const existing = FIXTURE_SCRIPTS.get(workId);
  if (existing !== undefined) return existing;
  const created = ScriptSchema.parse({
    id: `sc_${workId}`,
    workId,
    version: 1,
    status: 'draft',
    confirmedAt: null,
    estimatedDuration: Math.round(FIXTURE_SCRIPT_TEXT.join('').length / 4.2),
    actualDuration: null,
    sections: [
      { kind: 'hook3s', lines: FIXTURE_SCRIPT_TEXT.slice(0, 2) },
      { kind: 'body', lines: FIXTURE_SCRIPT_TEXT.slice(2, 7) },
      { kind: 'outro', lines: FIXTURE_SCRIPT_TEXT.slice(7) },
    ].map((section, sectionIndex) => ({
      id: `ss_${workId}_${sectionIndex}`,
      kind: section.kind,
      ord: sectionIndex,
      rangeStart: null,
      rangeEnd: null,
      lines: section.lines.map((text, lineIndex) => ({
        id: `sl_${workId}_${sectionIndex}_${lineIndex}`,
        sectionId: `ss_${workId}_${sectionIndex}`,
        ord: lineIndex,
        text,
        editedByUser: false,
        charCount: [...text].length,
      })),
    })),
  });
  FIXTURE_SCRIPTS.set(workId, created);
  return created;
}

function updateFixtureWork(
  workId: string,
  mutate: (work: WorkEnvelope) => WorkEnvelope,
): WorkEnvelope {
  const current = FIXTURE_WORKS.get(workId);
  if (current === undefined) throw new Error(`占位数据里没有作品 ${workId}`);
  const updated = WorkEnvelopeSchema.parse(mutate(current));
  FIXTURE_WORKS.set(workId, updated);
  return updated;
}

export function generateFixtureScript(workId: string): Job {
  fixtureScript(workId);
  return JobSchema.parse({
    id: `sc_${workId}`,
    workId,
    type: 'script',
    status: 'succeeded',
    stage: null,
    progress: 100,
    costPoints: 0,
    reservationId: null,
    attempt: 0,
    error: null,
    createdAt: '2026-11-16T12:00:00.000Z',
    updatedAt: '2026-11-16T12:00:00.000Z',
  });
}

export function fetchFixtureScript(workId: string): Script {
  const existing = FIXTURE_SCRIPTS.get(workId);
  if (existing === undefined) throw new Error('SCRIPT_NOT_FOUND');
  return existing;
}

export function patchFixtureScript(
  workId: string,
  input: {
    baseVersion: number;
    sections: readonly {
      kind: 'hook3s' | 'body' | 'outro';
      lines: readonly { id?: string; ord: number; text: string }[];
    }[];
  },
): PatchScriptResponse {
  const current = fixtureScript(workId);
  if (current.version !== input.baseVersion) throw new Error('SCRIPT_VERSION_CONFLICT');
  const allLines = input.sections.flatMap((section) => section.lines);
  const chars = allLines.reduce((sum, line) => sum + [...line.text].length, 0);
  const updated: Script = {
    ...current,
    version: current.version + 1,
    estimatedDuration: Math.round(chars / 4.2),
    sections: current.sections.map((section, sectionIndex) => ({
      ...section,
      kind: input.sections[sectionIndex]?.kind ?? section.kind,
      ord: sectionIndex,
      lines: (input.sections[sectionIndex]?.lines ?? []).map((line, lineIndex) => ({
        id: line.id ?? section.lines[lineIndex]?.id ?? `sl_${workId}_${sectionIndex}_${lineIndex}`,
        sectionId: section.id,
        ord: lineIndex,
        text: line.text,
        editedByUser: true,
        charCount: [...line.text].length,
      })),
    })),
  };
  FIXTURE_SCRIPTS.set(workId, updated);
  return PatchScriptResponse.parse({
    script: updated,
    envelope: updateFixtureWork(workId, (work) => work),
  });
}

export const FIXTURE_STYLE_SAMPLES: StyleSample[] = [
  StyleSampleSchema.parse({
    id: 'sty_fixture_1',
    title: '我的风格样本',
    source: 'paste',
    status: 'ready',
    charCount: 32,
    createdAt: '2026-11-16T12:00:00.000Z',
  }),
];

export const FIXTURE_STYLE_PROFILE: StyleProfile = StyleProfileSchema.parse({
  catchphrases: ['说人话就是'],
  sentencePatterns: ['先结论，再案例'],
  casePreferences: ['身边案例'],
  tone: '直接、亲近',
  sampleCount: 1,
  version: 1,
  isDefault: false,
  updatedAt: '2026-11-16T12:00:00.000Z',
});

export function createFixtureStyleSample(input: {
  title: string;
  content: string;
  source: 'upload' | 'paste';
}): StyleSample {
  return StyleSampleSchema.parse({
    id: `sty_${Date.now()}`,
    title: input.title,
    source: input.source,
    status: 'ready',
    charCount: [...input.content].length,
    createdAt: new Date().toISOString(),
  });
}

const FIXTURE_HUNKS = new Map<string, StyleHunk[]>();

export function restyleFixtureScript(workId: string): RestyleResponse {
  const script = fixtureScript(workId);
  const lines = script.sections.flatMap((section) => section.lines).slice(0, 4);
  const hunks = lines.map((line, index) => ({
    id: `sh_${workId}_${index}`,
    scriptId: script.id,
    lineId: line.id,
    ord: index,
    original: line.text,
    rewritten: `说人话就是，${line.text.replace(/。$/, '')}。`,
    status: 'pending' as const,
    resolvedAt: null,
  }));
  FIXTURE_HUNKS.set(workId, hunks);
  return RestyleResponse.parse({
    hunks,
    envelope: updateFixtureWork(workId, (work) => work),
  });
}

export function resolveFixtureStyleHunk(workId: string, hunkId: string, accept: boolean): void {
  const hunk = FIXTURE_HUNKS.get(workId)?.find((item) => item.id === hunkId);
  if (hunk === undefined) throw new Error('HUNK_NOT_FOUND');
  const script = fixtureScript(workId);
  if (accept && hunk.lineId !== null) {
    FIXTURE_SCRIPTS.set(workId, {
      ...script,
      version: script.version + 1,
      sections: script.sections.map((section) => ({
        ...section,
        lines: section.lines.map((line) =>
          line.id === hunk.lineId ? { ...line, text: hunk.rewritten, editedByUser: true } : line,
        ),
      })),
    });
  }
  FIXTURE_HUNKS.set(
    workId,
    (FIXTURE_HUNKS.get(workId) ?? []).map((item) =>
      item.id === hunkId
        ? {
            ...item,
            status: accept ? 'accepted' : 'rejected',
            resolvedAt: new Date().toISOString(),
          }
        : item,
    ),
  );
}

function setFixtureG2(
  workId: string,
  confirmed: boolean,
  step: 'script' | 'video.draft',
): WorkEnvelope {
  return updateFixtureWork(workId, (work) => {
    const gateDetails = { ...work.gateDetails };
    if (confirmed) delete gateDetails.G2;
    else {
      gateDetails.G2 = {
        satisfied: false,
        reason: 'SCRIPT_NOT_CONFIRMED',
        redirectTo: `/studio/${workId}/script`,
      };
    }
    return {
      ...work,
      gates: { ...work.gates, G2: confirmed },
      gateDetails,
      scriptConfirmedAt: confirmed ? new Date().toISOString() : null,
      step,
      phase: step === 'script' ? 1 : 2,
    };
  });
}

export function confirmFixtureScript(workId: string): WorkEnvelope {
  const script = fixtureScript(workId);
  FIXTURE_SCRIPTS.set(workId, {
    ...script,
    status: 'confirmed',
    confirmedAt: new Date().toISOString(),
  });
  return setFixtureG2(workId, true, 'video.draft');
}

export function unlockFixtureScript(workId: string): WorkEnvelope {
  const script = fixtureScript(workId);
  FIXTURE_SCRIPTS.set(workId, { ...script, status: 'stale', confirmedAt: null });
  return setFixtureG2(workId, false, 'script');
}

const FIXTURE_RENDER_JOBS = new Map<string, { job: Job; videoUrl: string | null }>();

function fixtureWorkAfterRender(workId: string, quality: 'draft' | 'hd'): void {
  const current = FIXTURE_WORKS.get(workId);
  if (current === undefined) return;
  const gateDetails = { ...current.gateDetails };
  const gates = { ...current.gates };
  if (quality === 'hd') {
    delete gateDetails.G3;
    gates.G3 = true;
  }
  const updated = WorkEnvelopeSchema.parse({
    ...current,
    gates,
    gateDetails,
    activeRenderJobId: null,
    step: quality === 'hd' ? 'video.rendered' : 'video.draft',
    phase: 2,
  });
  FIXTURE_WORKS.set(workId, updated);
}

export function startFixtureRender(workId: string, quality: 'draft' | 'hd'): RenderAccepted {
  const jobId = `job_${quality}_${workId}`;
  const now = new Date().toISOString();
  FIXTURE_RENDER_JOBS.set(jobId, {
    job: {
      id: jobId,
      workId,
      type: quality,
      status: 'succeeded',
      stage: 'finalize',
      progress: 100,
      costPoints: quality === 'hd' ? 2 : 0,
      reservationId: null,
      attempt: 0,
      error: null,
      createdAt: now,
      updatedAt: now,
    },
    videoUrl: '/fixture-video.mp4',
  });
  fixtureWorkAfterRender(workId, quality);
  return RenderAccepted.parse({
    jobId,
    costPoints: quality === 'hd' ? 2 : 0,
    reservationId: null,
    quota: FIXTURE_QUOTA,
    sseUrl: `/api/jobs/${jobId}/events`,
  });
}

export function fetchFixtureRenderJob(jobId: string): { job: Job; videoUrl: string | null } {
  const job = FIXTURE_RENDER_JOBS.get(jobId);
  if (job !== undefined) return job;
  if (jobId !== 'job_88') throw new Error('RENDER_NOT_FOUND');
  const now = new Date().toISOString();
  return {
    job: {
      id: jobId,
      workId: 'w1',
      type: 'hd',
      status: 'succeeded',
      stage: 'finalize',
      progress: 100,
      costPoints: 2,
      reservationId: null,
      attempt: 0,
      error: null,
      createdAt: now,
      updatedAt: now,
    },
    videoUrl: '/fixture-video.mp4',
  };
}

export function cancelFixtureRenderJob(jobId: string): void {
  const current = FIXTURE_RENDER_JOBS.get(jobId);
  if (current === undefined) throw new Error('RENDER_NOT_FOUND');
  FIXTURE_RENDER_JOBS.set(jobId, {
    videoUrl: null,
    job: { ...current.job, status: 'canceled', progress: 0 },
  });
  const work = FIXTURE_WORKS.get(current.job.workId);
  if (work !== undefined) {
    FIXTURE_WORKS.set(
      current.job.workId,
      WorkEnvelopeSchema.parse({ ...work, activeRenderJobId: null, step: 'video.draft', phase: 2 }),
    );
  }
}

export function retryFixtureRenderJob(workId: string, jobId: string): void {
  const current = FIXTURE_RENDER_JOBS.get(jobId);
  if (current === undefined) throw new Error('RENDER_NOT_FOUND');
  FIXTURE_RENDER_JOBS.set(jobId, {
    job: { ...current.job, status: 'succeeded', progress: 100 },
    videoUrl: '/fixture-video.mp4',
  });
  fixtureWorkAfterRender(workId, current.job.type === 'hd' ? 'hd' : 'draft');
}
