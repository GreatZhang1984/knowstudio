import { z } from 'zod';
import { GatesSchema, PrefixedId, QuotaSchema, RelativePath } from './dto.js';
import { JobStatus } from './enums.js';

/**
 * 长任务阶段的**唯一值域**，SSE 与降级轮询 `GET /jobs/:id` 共用（架构 §6.6 / §10.4）。
 * 两条通道必须同源，否则前端在降级路径上失去值域保护。
 * 渲染六段来自架构 §6.6 权重表；`package` / `manifest` 来自 D-20 的导出管线
 * （流式 zip 已有产物 → manifest/清单渲染 → 上传登记）。
 * AI 类 job（search/topics/script/restyle）的阶段语义尚未定义，其 stage 为 null。
 */
export const JobStage = z.enum([
  'queued',
  'tts',
  'slides',
  'align',
  'mux',
  'finalize',
  'package',
  'manifest',
] as const);
export type JobStage = z.infer<typeof JobStage>;

export const RenderStage = JobStage.extract(['queued', 'tts', 'slides', 'align', 'mux', 'finalize']);
export type RenderStage = z.infer<typeof RenderStage>;

/** 派生复用母版 audio，只按 orient 重排 slides + mux（架构 §6.3），故是渲染阶段的子集。 */
export const DeriveStage = JobStage.extract(['queued', 'slides', 'mux', 'finalize']);
export type DeriveStage = z.infer<typeof DeriveStage>;

export const ExportStage = JobStage.extract(['queued', 'package', 'manifest', 'finalize']);
export type ExportStage = z.infer<typeof ExportStage>;

/** 每类长任务允许上报的 stage，供 worker 与前端分支共用。 */
export const STAGES_BY_JOB_TYPE = {
  draft: RenderStage,
  hd: RenderStage,
  patch: RenderStage,
  derive_media: DeriveStage,
  export: ExportStage,
} as const;

/**
 * 渲染阶段权重区间（架构 §6.6 逐字）。权重本身由 domain 纯函数计算，此处只约束值域。
 * 导出阶段的区间架构未给数字，归 T-40+ 定义，不在此编造。
 */
export const STAGE_BOUNDS = {
  queued: [0, 5],
  tts: [5, 30],
  slides: [30, 60],
  align: [60, 70],
  mux: [70, 95],
  finalize: [95, 100],
} as const satisfies Record<RenderStage, readonly [number, number]>;

export const SseProgress = z.object({
  event: z.literal('progress'),
  seq: z.number().int().min(0),
  jobId: PrefixedId,
  stage: JobStage,
  progress: z.number().int().min(0).max(100),
  elapsedMs: z.number().int().min(0),
  etaMs: z.number().int().min(0).nullable(),
});

export const SseQuota = z.object({
  event: z.literal('quota'),
  seq: z.number().int().min(0),
  quota: QuotaSchema,
});

export const SseStatus = z.object({
  event: z.literal('status'),
  seq: z.number().int().min(0),
  jobId: PrefixedId,
  status: JobStatus,
  videoAssetId: PrefixedId.nullable(),
  durationMs: z.number().int().min(0).nullable(),
});

export const SseDone = z.object({
  event: z.literal('done'),
  seq: z.number().int().min(0),
  jobId: PrefixedId,
  redirectTo: RelativePath,
  gates: GatesSchema,
});

export const SseError = z.object({
  event: z.literal('error'),
  seq: z.number().int().min(0),
  jobId: PrefixedId,
  layer: z.string().nullable(),
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
});

export const SseWarning = z.object({
  event: z.literal('warning'),
  seq: z.number().int().min(0),
  jobId: PrefixedId,
  code: z.string(),
  message: z.string(),
});

/**
 * SSE 事件联合（架构 §6.6）。`seq` 即 render_job_event.seq，
 * 客户端断线后以 Last-Event-ID 携带，服务端先回放再转实时。
 * 心跳是注释行（`: heartbeat`），不是事件，故不在本联合中。
 */
export const SseEventSchema = z.discriminatedUnion('event', [
  SseProgress,
  SseQuota,
  SseStatus,
  SseDone,
  SseError,
  SseWarning,
]);
export type SseEvent = z.infer<typeof SseEventSchema>;

/** SSE 不可用时的降级轮询间隔（架构 §6.6：≥3s，指数退避到 10s）。 */
export const SSE_FALLBACK_POLL_MS = { min: 3000, max: 10000 } as const;
export const SSE_HEARTBEAT_MS = 15000;