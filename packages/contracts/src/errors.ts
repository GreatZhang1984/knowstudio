import { z } from 'zod';
import { GateId } from './enums.js';
import { ComplianceItemSchema, GateReason, PrefixedId, RelativePath, UtcTimestamp } from './dto.js';
import { ScriptSnapshotSchema } from './script.js';

/**
 * 错误码体系（架构 §10.2）。code 是稳定枚举，前端按 code 分支，绝不解析 message。
 * GATE_NOT_SATISFIED 与 COMPLIANCE_BLOCKED 分开：前者「你还没走到这一步」，
 * 后者「你走到了但有侵权项」，两者修复 UI 不同。
 */
export const ERROR_HTTP_STATUS = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  QUOTA_INSUFFICIENT: 402,
  NOT_FOUND: 404,
  GATE_NOT_SATISFIED: 409,
  RENDER_IN_PROGRESS: 409,
  SCRIPT_LOCKED: 409,
  AUTOSAVE_CONFLICT: 409,
  STALE_ASSET: 409,
  UPLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  COMPLIANCE_BLOCKED: 422,
  RATE_LIMITED: 429,
  UPSTREAM_FAILED: 502,
  RENDER_QUEUE_UNAVAILABLE: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_HTTP_STATUS;
export const ERROR_CODES = Object.keys(ERROR_HTTP_STATUS) as [ErrorCode, ...ErrorCode[]];
export const ErrorCodeSchema = z.enum(ERROR_CODES);

const err = <C extends ErrorCode, D extends z.ZodTypeAny>(code: C, details: D) =>
  z.object({
    code: z.literal(code),
    message: z.string(),
    details,
  });

export const ValidationFailed = err(
  'VALIDATION_FAILED',
  z.object({ fields: z.array(z.object({ path: z.string(), message: z.string() })) }),
);

export const Unauthenticated = err(
  'UNAUTHENTICATED',
  z.object({ loginUrl: RelativePath }),
);

/** 402：额度不足。options 给出升级/等待重置等出路（SPEC §3.6）。 */
export const QuotaInsufficient = err(
  'QUOTA_INSUFFICIENT',
  z.object({
    need: z.number().int().min(0),
    left: z.number().int(),
    resetAt: UtcTimestamp,
    options: z.array(z.object({ kind: z.string(), label: z.string() })),
  }),
);

/** 404：不存在**或不属于你**，一律 404 而非 403，避免枚举探测（架构 §10.1）。 */
export const NotFound = err('NOT_FOUND', z.object({}).strict());

/** 409：闸门未满足。必带 requiredGate 与 redirectTo，前端据此渲染 GateLocked。 */
export const GateNotSatisfied = err(
  'GATE_NOT_SATISFIED',
  z.object({
    requiredGate: GateId,
    redirectTo: RelativePath,
    reason: GateReason,
  }),
);

/** 409：渲染并发上限 1/用户。 */
export const RenderInProgress = err(
  'RENDER_IN_PROGRESS',
  z.object({ activeJobId: PrefixedId }),
);

export const ScriptLocked = err('SCRIPT_LOCKED', z.object({ unlockUrl: RelativePath }));

export const AutosaveConflict = err(
  'AUTOSAVE_CONFLICT',
  z.object({
    serverVersion: z.number().int().min(1),
    serverSnapshot: ScriptSnapshotSchema,
    clientSnapshot: ScriptSnapshotSchema,
  }),
);

export const StaleAsset = err(
  'STALE_ASSET',
  z.object({
    scriptVersion: z.number().int().min(0),
    assetVersion: z.number().int().min(0),
  }),
);

export const UploadTooLarge = err('UPLOAD_TOO_LARGE', z.object({ maxBytes: z.number().int().min(1) }));

export const UnsupportedMediaType = err(
  'UNSUPPORTED_MEDIA_TYPE',
  z.object({ allowed: z.array(z.string()) }),
);

/** 422：合规阻断，导出前置。blockingItems 定位到素材/文案行（架构 §8.6）。 */
export const ComplianceBlocked = err(
  'COMPLIANCE_BLOCKED',
  z.object({
    reportId: PrefixedId,
    blockingItems: z.array(ComplianceItemSchema),
  }),
);

export const RateLimited = err('RATE_LIMITED', z.object({ retryAfterSec: z.number().int().min(0) }));

export const UpstreamFailed = err(
  'UPSTREAM_FAILED',
  z.object({ port: z.string(), providers: z.array(z.string()) }),
);

export const RenderQueueUnavailable = err(
  'RENDER_QUEUE_UNAVAILABLE',
  z.object({ retryAfterSec: z.number().int().min(0) }),
);

/** 判别联合： narrowing on code 后 details 自动获得精确类型。 */
export const ApiErrorSchema = z.discriminatedUnion('code', [
  ValidationFailed,
  Unauthenticated,
  QuotaInsufficient,
  NotFound,
  GateNotSatisfied,
  RenderInProgress,
  ScriptLocked,
  AutosaveConflict,
  StaleAsset,
  UploadTooLarge,
  UnsupportedMediaType,
  ComplianceBlocked,
  RateLimited,
  UpstreamFailed,
  RenderQueueUnavailable,
]);
export type ApiError = z.infer<typeof ApiErrorSchema>;

export type ApiErrorFor<C extends ErrorCode> = Extract<ApiError, { code: C }>;

export const httpStatusOf = (code: ErrorCode): number => ERROR_HTTP_STATUS[code];