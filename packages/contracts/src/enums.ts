import { z } from 'zod';

/**
 * 唯一契约源（架构 §3.1 / §10）。值域与 SPEC §4.2、架构 §4.2 枚举表逐字一致。
 * 约定：枚举只许在末尾追加，永不重排（架构 §4.2，MySQL 原生 ENUM 的 INPLACE 迁移前提）。
 */

const enumOf = <T extends readonly [string, ...string[]]>(values: T) =>
  Object.assign(z.enum(values), { values });

export const WorkStep = enumOf([
  'search',
  'topics',
  'script',
  'video.draft',
  'video.rendering',
  'video.rendered',
  'derive',
  'export',
  'done',
] as const);
export type WorkStep = z.infer<typeof WorkStep>;

export const MaterialType = enumOf([
  'knowledge',
  'hot',
  'peer',
  'image',
  'doc',
  'music',
  'font',
] as const);
export type MaterialType = z.infer<typeof MaterialType>;

/** unknown 一律按 restricted 处理（SPEC §8.1）。 */
export const LicenseState = enumOf(['cleared', 'restricted', 'unknown'] as const);
export type LicenseState = z.infer<typeof LicenseState>;

export const ScriptStatus = enumOf(['draft', 'confirmed', 'stale'] as const);
export type ScriptStatus = z.infer<typeof ScriptStatus>;

export const SectionKind = enumOf(['hook3s', 'body', 'outro'] as const);
export type SectionKind = z.infer<typeof SectionKind>;

export const RevisionReason = enumOf([
  'generate',
  'edit',
  'restyle',
  'accept',
  'reject',
  'unlock',
] as const);
export type RevisionReason = z.infer<typeof RevisionReason>;

export const HunkStatus = enumOf(['pending', 'accepted', 'rejected'] as const);
export type HunkStatus = z.infer<typeof HunkStatus>;

export const AssetQuality = enumOf(['draft', 'hd', 'uhd4k'] as const);
export type AssetQuality = z.infer<typeof AssetQuality>;

export const LayerKind = enumOf([
  'audio',
  'slides',
  'subtitles',
  'timeline',
  'bgm',
  'cover',
] as const);
export type LayerKind = z.infer<typeof LayerKind>;

export const JobType = enumOf([
  'draft',
  'hd',
  'patch',
  'derive_media',
  'export',
  'search',
  'topics',
  'script',
  'restyle',
] as const);
export type JobType = z.infer<typeof JobType>;

/** render_job / video_asset / search_session / export_package 共用。 */
export const JobStatus = enumOf([
  'queued',
  'running',
  'succeeded',
  'failed',
  'canceled',
] as const);
export type JobStatus = z.infer<typeof JobStatus>;

export const DurationVersion = enumOf(['full', 'essence30', 'teaser15'] as const);
export type DurationVersion = z.infer<typeof DurationVersion>;

export const ComplianceKind = enumOf(['image', 'music', 'font', 'content'] as const);
export type ComplianceKind = z.infer<typeof ComplianceKind>;

export const ComplianceState = enumOf(['pass', 'warn', 'block'] as const);
export type ComplianceState = z.infer<typeof ComplianceState>;

export const QuotaAction = enumOf([
  'grant',
  'reserve',
  'commit',
  'release',
  'reset',
  'adjust',
] as const);
export type QuotaAction = z.infer<typeof QuotaAction>;

export const ReservationState = enumOf([
  'held',
  'committed',
  'released',
  'expired',
] as const);
export type ReservationState = z.infer<typeof ReservationState>;

export const TrendLifecycle = enumOf(['rising', 'peaked', 'faded'] as const);
export type TrendLifecycle = z.infer<typeof TrendLifecycle>;

/** 自研 job_queue（架构 §4.2，MySQL 8 无 pg-boss）。 */
export const QueueState = enumOf([
  'pending',
  'leased',
  'done',
  'dead',
  'canceled',
] as const);
export type QueueState = z.infer<typeof QueueState>;

// ── 非落库枚举 ────────────────────────────────────────────────────────────────

/** UI 四段流水线：0 搜 / 1 想 / 2 做 / 3 发 / 4 已导出（SPEC §2.2）。 */
export const Phase = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
]);
export type Phase = z.infer<typeof Phase>;
export const PHASES = [0, 1, 2, 3, 4] as const;

/** 抖音 / 视频号 / B站 / 小红书（架构 §4.3 platform_rule 种子）。 */
export const PlatformId = enumOf(['douyin', 'sph', 'bili', 'xhs'] as const);
export type PlatformId = z.infer<typeof PlatformId>;

/**
 * 可派生的人工把关门。G5「永不自动发布」不是可满足的门，而是静态禁令：
 * 系统不提供任何平台发布写接口（SPEC §2.3 / 架构 §5.5），故不在 Gates 中出现。
 */
export const GateId = enumOf(['G1', 'G2', 'G3', 'G4'] as const);
export type GateId = z.infer<typeof GateId>;

/** D-07 派生二分（架构 §5.4，A1 已拍板收窄）：metadata 仅需 G2，media 需 G3。 */
export const DeriveScope = enumOf(['metadata', 'media'] as const);
export type DeriveScope = z.infer<typeof DeriveScope>;

/**
 * 18 个落库枚举的清单，顺序即架构 §4.2 表顺序。
 * MySQL ENUM 迁移、OpenAPI 组件、值域一致性测试都从这里取，避免三处各抄一份。
 */
export const DB_ENUMS = {
  WorkStep,
  MaterialType,
  LicenseState,
  ScriptStatus,
  SectionKind,
  RevisionReason,
  HunkStatus,
  AssetQuality,
  LayerKind,
  JobType,
  JobStatus,
  DurationVersion,
  ComplianceKind,
  ComplianceState,
  QuotaAction,
  ReservationState,
  TrendLifecycle,
  QueueState,
} as const;
export type DbEnumName = keyof typeof DB_ENUMS;