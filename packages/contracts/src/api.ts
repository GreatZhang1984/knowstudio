import { z } from 'zod';
import {
  ComplianceReportSchema,
  GatesSchema,
  HttpUrl,
  PrefixedId,
  QuotaSchema,
  RelativePath,
  UtcTimestamp,
  WorkEnvelopeSchema,
} from './dto.js';
import {
  AssetQuality,
  DeriveScope,
  DurationVersion,
  HunkStatus,
  JobStatus,
  JobType,
  LayerKind,
  LicenseState,
  MaterialType,
  Phase,
  PlatformId,
  QuotaAction,
  SectionKind,
  WorkStep,
} from './enums.js';
import { DerivativeSchema, ScriptSchema } from './script.js';
import { JobStage } from './sse.js';

// ── 通用 ──────────────────────────────────────────────────────────────────────

/** 游标基于 (updated_at, id)，避免深翻页 OFFSET（架构 §10.1）。 */
export const PaginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});
export type PaginationQuery = z.infer<typeof PaginationQuery>;

export const pageOf = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
    total: z.number().int().min(0).optional(),
  });

/** 所有 POST 写操作支持幂等键（架构 §10.1）。 */
export const IdempotencyKeyHeader = z.string().uuid();

// ── Work ──────────────────────────────────────────────────────────────────────

export const CreateWorkRequest = z.object({
  /** SPEC §3.2：关键词或领域，必填 1–40 字。 */
  keyword: z.string().min(1).max(40),
  title: z.string().max(200).optional(),
});
export type CreateWorkRequest = z.infer<typeof CreateWorkRequest>;

/** SPEC §5 作品行：PATCH /works/:id（工作台改名）。 */
export const PatchWorkRequest = z.object({ title: z.string().min(1).max(200) });
export type PatchWorkRequest = z.infer<typeof PatchWorkRequest>;

export const ListWorksQuery = PaginationQuery.extend({
  phase: z.coerce.number().int().min(0).max(4).optional(),
  q: z.string().max(100).optional(),
});

export const WorkListItem = z.object({
  id: PrefixedId,
  title: z.string(),
  keyword: z.string(),
  phase: Phase,
  step: WorkStep,
  progress: z.number().int().min(0).max(100),
  gates: GatesSchema,
  updatedAt: UtcTimestamp,
});
export type WorkListItem = z.infer<typeof WorkListItem>;

/** 新建 Work 返回完整信封，不继承任何旧 Work 状态（D-05）。 */
export const CreateWorkResponse = WorkEnvelopeSchema;

// ── 选题 ──────────────────────────────────────────────────────────────────────

/** SPEC §5 选题行：首批选题生成。缺了它 G1 永远无法达成。 */
export const GenerateTopicsRequest = z.object({
  materialIds: z.array(PrefixedId).min(1),
  blankAngleIds: z.array(PrefixedId).optional(),
  trendId: PrefixedId.optional(),
});
export type GenerateTopicsRequest = z.infer<typeof GenerateTopicsRequest>;

/** SPEC §5：GET /works/:id/topics?batch= */
export const TopicsQuery = z.object({ batch: z.coerce.number().int().min(1).optional() });

export const SelectTopicRequest = z.object({ topicId: PrefixedId });

export const TopicSchema = z.object({
  id: PrefixedId,
  batchId: PrefixedId,
  hook: z.string(),
  gap: z.string(),
  basisMaterialIds: z.array(PrefixedId).min(1),
  hookFingerprint: z.string(),
});
export type Topic = z.infer<typeof TopicSchema>;

export const TopicBatchSchema = z.object({
  id: PrefixedId,
  workId: PrefixedId,
  batchIndex: z.number().int().min(1),
  topics: z.array(TopicSchema),
  /** 差异不足时明示有效数量，不假装给满 12 条（SPEC §6.2 / D-09）。 */
  requestedCount: z.number().int().min(0),
  minPairwiseCosine: z.number().min(0).max(1).nullable(),
});
export type TopicBatch = z.infer<typeof TopicBatchSchema>;

/** 换一批：202，batchIndex 递增，跨批指纹去重，不走缓存（D-09）。 */
export const RerollAccepted = z.object({
  batchId: PrefixedId,
  batchIndex: z.number().int().min(1),
  status: JobStatus,
});
export type RerollAccepted = z.infer<typeof RerollAccepted>;

// ── 文案 ──────────────────────────────────────────────────────────────────────

export const GenerateScriptRequest = z.object({
  platformId: PlatformId.optional(),
  styleProfileId: PrefixedId.optional(),
});

/** 携带 baseVersion；不匹配 → 409 AUTOSAVE_CONFLICT + 双版本快照。 */
export const PatchScriptRequest = z.object({
  baseVersion: z.number().int().min(1),
  sections: z.array(
    z.object({
      kind: SectionKind,
      lines: z.array(
        z.object({ id: PrefixedId.optional(), ord: z.number().int().min(0), text: z.string() }),
      ),
    }),
  ),
});
export type PatchScriptRequest = z.infer<typeof PatchScriptRequest>;

export const PatchScriptResponse = z.object({
  script: ScriptSchema,
  envelope: WorkEnvelopeSchema,
});
export type PatchScriptResponse = z.infer<typeof PatchScriptResponse>;

export const ConfirmScriptResponse = z.object({
  script: ScriptSchema,
  envelope: WorkEnvelopeSchema,
});
export type ConfirmScriptResponse = z.infer<typeof ConfirmScriptResponse>;

/** 解锁：G2/G3/G4 全部失效 + 所有 video_asset.stale=true。 */
export const UnlockScriptResponse = z.object({
  affectedAssets: z.array(
    z.object({ id: PrefixedId, quality: AssetQuality, stale: z.literal(true) }),
  ),
  rerenderCost: z.number().int().min(0),
  envelope: WorkEnvelopeSchema,
});
export type UnlockScriptResponse = z.infer<typeof UnlockScriptResponse>;

// ── 风格重写（SPEC §5 文案行 / Story 4 / D-12：句级 hunk，不是只弹 toast）────────

export const RestyleRequest = z.object({ sampleIds: z.array(PrefixedId).min(1) });
export type RestyleRequest = z.infer<typeof RestyleRequest>;

/** 形状对齐架构 §4.4 `style_hunk` DDL。 */
export const StyleHunkSchema = z.object({
  id: PrefixedId,
  scriptId: PrefixedId,
  lineId: PrefixedId.nullable(),
  ord: z.number().int().min(0),
  original: z.string(),
  rewritten: z.string(),
  status: HunkStatus,
  resolvedAt: UtcTimestamp.nullable(),
});
export type StyleHunk = z.infer<typeof StyleHunkSchema>;

export const RestyleResponse = z.object({
  hunks: z.array(StyleHunkSchema),
  envelope: WorkEnvelopeSchema,
});
export type RestyleResponse = z.infer<typeof RestyleResponse>;

/** 逐句 accept/reject 落 script_revision，故同时返回新文案与新信封。 */
export const HunkActionResponse = z.object({
  hunk: StyleHunkSchema,
  script: ScriptSchema,
  envelope: WorkEnvelopeSchema,
});
export type HunkActionResponse = z.infer<typeof HunkActionResponse>;

// ── 视频与渲染 ────────────────────────────────────────────────────────────────

/** SPEC §5 视频行：draft / render 只带 quality。 */
export const RenderRequest = z.object({ quality: AssetQuality.default('hd') });
export type RenderRequest = z.infer<typeof RenderRequest>;

/** SPEC §5：PATCH /works/:id/video {voiceId?, templateId?, subtitle?, speed?}，只算增量不下单。 */
export const PatchVideoRequest = z.object({
  voiceId: PrefixedId.optional(),
  templateId: PrefixedId.optional(),
  subtitle: z.boolean().optional(),
  speed: z.number().min(0.5).max(2).optional(),
});
export type PatchVideoRequest = z.infer<typeof PatchVideoRequest>;

/** SPEC §5：POST /works/:id/video:patch {layerScope}。 */
export const VideoPatchRequest = z.object({ layerScope: z.array(LayerKind).min(1) });
export type VideoPatchRequest = z.infer<typeof VideoPatchRequest>;

/** 202 响应（SPEC §5 示例 / 架构 §10.3）。 */
export const RenderAccepted = z.object({
  jobId: PrefixedId,
  costPoints: z.number().int().min(0),
  reservationId: PrefixedId.nullable(),
  quota: QuotaSchema,
  sseUrl: RelativePath,
});
export type RenderAccepted = z.infer<typeof RenderAccepted>;

/** PATCH /video 只返回增量点数，**不下单**（架构 §6.2 / §10.3）。 */
export const PatchVideoResponse = z.object({
  invalidatedLayers: z.array(LayerKind),
  incrementalPoints: z.number().int().min(0),
  requiresConfirm: z.boolean(),
});
export type PatchVideoResponse = z.infer<typeof PatchVideoResponse>;

export const JobSchema = z.object({
  id: PrefixedId,
  workId: PrefixedId,
  type: JobType,
  status: JobStatus,
  /** 与 SSE 同源（架构 §6.6 / §10.4）；AI 类 job 阶段未定义时为 null。 */
  stage: JobStage.nullable(),
  progress: z.number().int().min(0).max(100),
  costPoints: z.number().int().min(0),
  reservationId: PrefixedId.nullable(),
  attempt: z.number().int().min(0),
  error: z
    .object({
      layer: z.string().nullable(),
      code: z.string(),
      message: z.string(),
      retryable: z.boolean(),
    })
    .nullable(),
  createdAt: UtcTimestamp,
  updatedAt: UtcTimestamp,
});
export type Job = z.infer<typeof JobSchema>;

// ── 派生 ──────────────────────────────────────────────────────────────────────

/** scope 缺省 media 以保持 SPEC 兼容（架构 §10.3）。 */
export const GenerateDerivativesRequest = z.object({
  scope: DeriveScope.default('media'),
  platformIds: z.array(PlatformId).min(1).optional(),
});
export type GenerateDerivativesRequest = z.infer<typeof GenerateDerivativesRequest>;

export const PatchDerivativeRequest = z.object({
  title: z.string().max(255).optional(),
  tags: z.array(z.string()).optional(),
  durationVersion: DurationVersion.optional(),
  /** SPEC §5 派生行含 cover?；封面层指纹由 frameTs 参与（架构 §6.1）。 */
  cover: z.object({ frameTs: z.number().int().min(0) }).optional(),
});

export const DerivativesResponse = z.object({
  derivatives: z.array(DerivativeSchema),
  envelope: WorkEnvelopeSchema,
});

/** SPEC §5 派生行：单平台标题重生成（Story 7）。 */
export const TitleRegenerateResponse = z.object({
  derivative: DerivativeSchema,
  envelope: WorkEnvelopeSchema,
});
export type TitleRegenerateResponse = z.infer<typeof TitleRegenerateResponse>;

// ── 合规与导出 ────────────────────────────────────────────────────────────────

export const ComplianceResponse = ComplianceReportSchema;

export const ExportAccepted = z.object({ exportId: PrefixedId });
export type ExportAccepted = z.infer<typeof ExportAccepted>;

export const ExportFileSchema = z.object({
  platformId: PlatformId.nullable(),
  kind: z.enum(['package', 'video', 'cover', 'manifest', 'checklist']),
  key: z.string(),
  path: z.string(),
  url: z.union([HttpUrl, RelativePath]),
  bytes: z.number().int().min(0),
  durationMs: z.number().int().min(0).nullable(),
});
export type ExportFile = z.infer<typeof ExportFileSchema>;

export const ExportPackageSchema = z.object({
  id: PrefixedId,
  workId: PrefixedId,
  status: JobStatus,
  files: z.array(ExportFileSchema),
  reportId: PrefixedId.nullable(),
  /** 签名 URL 24h；过期后 GET /exports/:id 重签，不需重新打包（AC-E6）。 */
  expiresAt: UtcTimestamp,
  createdAt: UtcTimestamp,
});
export type ExportPackage = z.infer<typeof ExportPackageSchema>;

// ── 搜索 ──────────────────────────────────────────────────────────────────────

export const SearchRequest = z.object({
  /**
   * 搜索归属的 Work。[待确认 #16] SPEC §5 路由简写 `POST /discover/search {keyword, domain}`
   * 未列 workId，但 SPEC §4 实体模型 `SearchSession{workId,...}` 与架构 §4.4 DDL
   * `search_session.work_id CHAR(36) NOT NULL FK→work(id)` 都要求每条搜索会话绑定一个 Work；
   * 收藏亦是 work 作用域（POST /works/:id/materials）。故按实体模型补必填 workId，
   * 由前端「当前作品」上下文携带（侧边栏步进器反映的当前 Work）。这是 SPEC 内部口径不一致的
   *  reconcile，不是新增需求；最终裁决归 #16。
   */
  workId: PrefixedId,
  /** SPEC §3.2：关键词或领域，必填 1–40 字。 */
  keyword: z.string().min(1).max(40),
  /** SPEC §3.2：可选领域偏好（来自设置）。SPEC 未枚举值域，故为自由短串。 */
  domain: z.string().min(1).max(40).optional(),
  force: z.boolean().default(false),
});
export type SearchRequest = z.infer<typeof SearchRequest>;

export const SearchAccepted = z.object({ searchId: PrefixedId, cacheHit: z.boolean() });

export const MaterialSchema = z.object({
  id: PrefixedId,
  type: MaterialType,
  title: z.string(),
  summary: z.string(),
  source: z.string(),
  /** 外部抓取源是不可信输入，禁 javascript:/data:（前端会渲染成 <a href>）。 */
  url: HttpUrl.nullable(),
  license: LicenseState,
  collected: z.boolean(),
});
export type Material = z.infer<typeof MaterialSchema>;

/** SPEC §5 搜索行：收藏落库（§1.5 注：P0 需最小可用形态）。 */
export const CollectMaterialRequest = z.object({ materialId: PrefixedId });
export type CollectMaterialRequest = z.infer<typeof CollectMaterialRequest>;

/** action-bar 的「已收藏 N 条素材」需要计数与新信封（架构 §5.6）。 */
export const CollectMaterialResponse = z.object({
  collectedCount: z.number().int().min(0),
  envelope: WorkEnvelopeSchema,
  /** T-55：被移除素材影响 slides 时，服务端同事务创建 0 点局部重算任务。 */
  patchJob: z
    .object({
      jobId: PrefixedId,
      costPoints: z.number().int().min(0),
      sseUrl: RelativePath,
    })
    .nullable(),
});
export type CollectMaterialResponse = z.infer<typeof CollectMaterialResponse>;

/** T-55：用同类型可见素材替换当前作品中的阻断素材。 */
export const ReplaceMaterialRequest = z.object({ materialId: PrefixedId });
export type ReplaceMaterialRequest = z.infer<typeof ReplaceMaterialRequest>;

/** T-55：为当前作品引用的素材绑定商用授权凭证；服务端复检后返回新报告。 */
export const AttachMaterialLicenseRequest = z.object({
  evidenceType: z.enum(['commercial_use_grant', 'license_document', 'authorization_letter']),
  evidenceUrl: HttpUrl,
  expiresAt: UtcTimestamp.optional(),
});
export type AttachMaterialLicenseRequest = z.infer<typeof AttachMaterialLicenseRequest>;

export const AttachMaterialLicenseResponse = z.object({
  materialId: PrefixedId,
  report: ComplianceReportSchema,
  envelope: WorkEnvelopeSchema,
});
export type AttachMaterialLicenseResponse = z.infer<typeof AttachMaterialLicenseResponse>;

export const SaturationSchema = z.object({
  score: z.number().min(0).max(100),
  /** SPEC §3.2 分档：0–40 蓝海 / 41–70 有空间 / 71–100 讲的人很多。 */
  level: z.enum(['blue_ocean', 'has_room', 'saturated']),
  confidence: z.number().min(0).max(1),
  sampleSize: z.number().int().min(0),
  coveredPlatforms: z.array(PlatformId),
  sources: z.array(z.string()),
  /** 样本不足时不给确定性结论（AC-D5）。 */
  sufficient: z.boolean(),
});
export type Saturation = z.infer<typeof SaturationSchema>;

/**
 * SPEC §3.2 空白角度是**带 id 的结构**，不是字符串数组——
 * `topics:generate {blankAngleIds}` 要引用它，纯字符串会让该参数无从取值。
 */
export const BlankAngleSchema = z.object({
  id: PrefixedId,
  label: z.string(),
  basisMaterialIds: z.array(PrefixedId),
  rationale: z.string(),
});
export type BlankAngle = z.infer<typeof BlankAngleSchema>;

export const SearchSessionSchema = z.object({
  id: PrefixedId,
  keyword: z.string(),
  status: JobStatus,
  materials: z.array(MaterialSchema),
  saturation: SaturationSchema.nullable(),
  blankAngles: z.array(BlankAngleSchema),
  partialErrors: z.array(z.object({ source: z.string(), code: z.string(), message: z.string() })),
  cacheHit: z.boolean(),
  createdAt: UtcTimestamp,
});
export type SearchSession = z.infer<typeof SearchSessionSchema>;

// ── 配额 ──────────────────────────────────────────────────────────────────────

export const QuotaResponse = QuotaSchema;

export const LedgerEntrySchema = z.object({
  id: z.number().int(),
  workId: PrefixedId.nullable(),
  jobId: PrefixedId.nullable(),
  action: QuotaAction,
  points: z.number().int(),
  balanceAfter: z.number().int(),
  note: z.string().nullable(),
  createdAt: UtcTimestamp,
});
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

export const LedgerQuery = PaginationQuery.extend({
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .optional(),
});

// ── 平台规则 ──────────────────────────────────────────────────────────────────

export const PlatformRuleSchema = z.object({
  platformId: PlatformId,
  version: z.number().int().min(1),
  // name/ratio/brandColor/styleHint/updatedAt 补齐 platform_rule DDL 列（arch:793–812）：
  // SPEC §3.6 平台 tab「名称+色点+画幅·时长」与封面预览面向用户，缺列会逼前端硬编码（D-02）。
  name: z.string(),
  ratio: z.string(),
  isCurrent: z.boolean(),
  titleMax: z.number().int().min(1),
  titleHardMax: z.number().int().min(1),
  tagMax: z.number().int().min(1),
  maxDurationSec: z.number().int().min(1),
  // DDL 是 ENUM('vertical','horizontal')；臆造的 'both' 会被 MySQL 拒收(1265)，本该 400 变 500。
  orient: z.enum(['vertical', 'horizontal']),
  brandColor: z.string(),
  styleHint: z.string(),
  bannedPatterns: z.array(z.string()),
  updatedAt: UtcTimestamp,
});
export type PlatformRule = z.infer<typeof PlatformRuleSchema>;

// ── 鉴权 ──────────────────────────────────────────────────────────────────────

export const LoginRequest = z.object({
  account: z.string().min(1),
  credential: z.string().min(1),
  method: z.enum(['password', 'code']),
});

export const TokenPair = z.object({
  accessToken: z.string(),
  expiresInSec: z.number().int().min(1),
  userId: PrefixedId,
});

/** 深链登录回跳（架构 §10.1 / T-06）。只收站内相对路径，否则是开放重定向钓鱼面。 */
export const ReturnToQuery = z.object({ returnTo: RelativePath.optional() });

// ── 账户（SPEC §5 账户行；形状对齐架构 §4.4 app_user DDL）──────────────────────

/** 绝不包含 password_hash；联系方式属设置页（P1），P0 只读身份与偏好。 */
export const MeResponse = z.object({
  id: PrefixedId,
  name: z.string(),
  avatarUrl: HttpUrl.nullable(),
  domainPrefs: z.array(z.string()),
  defaultPlatforms: z.array(PlatformId),
  planId: z.string(),
  theme: z.enum(['dark', 'light']),
  onboardedAt: UtcTimestamp.nullable(),
  createdAt: UtcTimestamp,
});
export type Me = z.infer<typeof MeResponse>;

// ── 风格（SPEC §5 风格行 spec:562）────────────────────────────────────────────
// P0 = **创建（上传/粘贴）+ 读取**：SPEC §3.4 spec:319「上传或粘贴过往文案；P0 需支持 ≥3 篇」，
// plan T-32 plan:143（S4 / M1）。restyle 是 P0，故产生样本的写接口也必须是 P0。
// P1 = **删除 + `/settings/style` 管理页**：SPEC §1.5 spec:81「风格样本管理」、
// §2.5 spec:190 管理页标 P1、plan S-M2-6 plan:66。不要把「管理是 P1」读成「写操作全是 P1」。

/** 列表项不含 content：样本正文可能很长且属隐私，服务端 restyle 时才读。 */
export const StyleSampleSchema = z.object({
  id: PrefixedId,
  title: z.string(),
  source: z.enum(['upload', 'paste']),
  status: z.enum(['learning', 'ready', 'failed']),
  charCount: z.number().int().min(0),
  createdAt: UtcTimestamp,
});
export type StyleSample = z.infer<typeof StyleSampleSchema>;

/**
 * 创建风格样本：SPEC §5 spec:562 `POST /style-samples`；
 * SPEC §3.4 spec:319「上传或粘贴过往文案；P0 需支持 ≥3 篇」；plan T-32 plan:143 验收 AC-S5。
 *
 * 字段逐项对齐架构 §4.4 `style_sample` DDL（arch:440–452）：
 * `title` VARCHAR(255) NOT NULL（arch:443）、`content` MEDIUMTEXT NOT NULL（arch:444）、
 * `source` ENUM('upload','paste') NOT NULL（arch:445）。
 *
 * **`status` 与 `charCount` 刻意不收**：DDL 给 status 定了 DEFAULT 'learning'（arch:446），
 * char_count 由服务端按 content 算（arch:447）——两者都是服务端权威字段。客户端若能传
 * `status:'ready'`，就等于跳过画像抽取、让 restyle 把没学过的样本当输入（SPEC §6 spec:615
 * 要求「样本 <1 篇时禁用」，篇数口径来自服务端）。故用 `.strict()`：多传一律
 * 400 VALIDATION_FAILED，而不是 zod 默认的静默 strip——静默忽略会让前端的 bug 永远不被发现。
 */
export const CreateStyleSampleRequest = z
  .object({
    /** 上限 255 来自 DDL（arch:443）；min(1) 同 PatchWorkRequest.title，避免列表出现无标题行。 */
    title: z.string().min(1).max(255),
    /**
     * SPEC 未给字数上限，故不拍数字。存储上限是 MEDIUMTEXT 的 16 MiB **字节**，
     * 而 zod `.max()` 数的是 UTF-16 码元：utf8mb4 下一个汉字 3 字节，写 `.max(16_777_215)`
     * 会放行约 3 倍于列容量的正文，把本该 400 的请求变成 DB 层 500。
     * 与仓库既有长文本字段（PatchScriptRequest.lines[].text、StyleHunkSchema.original）
     * 一致不设字符上限；产品级上限与请求体大小限制 [待确认]，归 API 层。
     */
    content: z.string().min(1),
    /** 复用响应 schema 的值域，避免请求/响应两处各抄一份 ENUM（arch:445）。 */
    source: StyleSampleSchema.shape.source,
  })
  .strict();
export type CreateStyleSampleRequest = z.infer<typeof CreateStyleSampleRequest>;

export const StyleProfileSchema = z.object({
  catchphrases: z.array(z.string()),
  sentencePatterns: z.array(z.string()),
  casePreferences: z.array(z.string()),
  tone: z.string().nullable(),
  sampleCount: z.number().int().min(0),
  version: z.number().int().min(1),
  /** SPEC §3.4 冷启动兜底：无样本时用默认风格，不阻断。 */
  isDefault: z.boolean(),
  updatedAt: UtcTimestamp,
});
export type StyleProfile = z.infer<typeof StyleProfileSchema>;

// ── 素材库最小可用（SPEC §1.5 注 / §3.9；完整检索与增删改归 P1）────────────────

export const LibraryQuery = PaginationQuery.extend({
  q: z.string().max(100).optional(),
  type: MaterialType.optional(),
  license: LicenseState.optional(),
});
export type LibraryQuery = z.infer<typeof LibraryQuery>;

// ── 埋点与指标（SPEC §11 / T-59·T-60）────────────────────────────────────────

export const AnalyticsEventName = z.enum([
  'work_created',
  'search_completed',
  'material_collected',
  'material_uncollected',
  'topic_batch_generated',
  'topic_selected',
  'script_generated',
  'script_first_edit',
  'script_confirmed',
  'style_hunk_accepted',
  'style_hunk_rejected',
  'draft_previewed',
  'render_started',
  'render_succeeded',
  'render_failed',
  'quota_insufficient',
  'video_patch_applied',
  'derivative_generated',
  'derivative_edited',
  'compliance_blocked',
  'export_completed',
  'publish_receipt_marked',
]);
export type AnalyticsEventName = z.infer<typeof AnalyticsEventName>;

/** 只允许客户端上报无法由服务端动作推导的事件；其余一律服务端双写。 */
export const ClientAnalyticsEventName = z.enum(['script_first_edit', 'publish_receipt_marked']);

export const AnalyticsEventRequest = z.object({
  event: ClientAnalyticsEventName,
  workId: PrefixedId,
  props: z.record(z.string().max(64), z.unknown()).default({}),
  occurredAt: UtcTimestamp,
});
export type AnalyticsEventRequest = z.infer<typeof AnalyticsEventRequest>;

export const RecordEventsRequest = z
  .object({ events: z.array(AnalyticsEventRequest).min(1).max(20) })
  .strict();
export type RecordEventsRequest = z.infer<typeof RecordEventsRequest>;

export const RecordEventsResponse = z.object({ accepted: z.number().int().min(0) });
export type RecordEventsResponse = z.infer<typeof RecordEventsResponse>;

export const MetricName = z.enum([
  'g1_e2e_p50',
  'g2_daily_days',
  'g3_polish_p50',
  'g5_adapt_p50',
  'g5_platform_coverage',
  'g6_cost_per_work',
  'major_edit_rate',
  'avg_points_per_work',
  'render_failure_rate',
  'compliance_block_rate',
  'north_star_within_60m',
]);
export type MetricName = z.infer<typeof MetricName>;

export const MetricSnapshotItem = z.object({
  metric: MetricName,
  value: z.number().nullable(),
  sampleN: z.number().int().min(0),
  bucket: UtcTimestamp,
  computedAt: UtcTimestamp,
});
export type MetricSnapshotItem = z.infer<typeof MetricSnapshotItem>;

export const MetricsResponse = z.object({
  items: z.array(MetricSnapshotItem),
  fresh: z.boolean(),
  generatedAt: UtcTimestamp.nullable(),
  g4BlindTest: z.object({ source: z.literal('manual'), value: z.number().nullable() }),
});
export type MetricsResponse = z.infer<typeof MetricsResponse>;
