import { z } from 'zod';
import {
  ComplianceKind,
  ComplianceState,
  JobStatus,
  LicenseState,
  Phase,
  PlatformId,
  ScriptStatus,
  WorkStep,
} from './enums.js';
import type { GateId } from './enums.js';

/**
 * RFC3339 UTC（架构 §10.1：时间一律 UTC，前端本地化）。
 * 必须**不带** `offset: true`——该选项会额外放行 `±HH:MM`，于是同一时刻的两种写法
 * 都能过校验，而 `bgm.evidenceExpiresAt` 原样进入合规指纹（§8.4），
 * 导致素材一个字没改却算出不同指纹、G4 伪陈旧。只收 `Z` 从入口消灭这种歧义。
 */
export const UtcTimestamp = z.string().datetime();
export type UtcTimestamp = z.infer<typeof UtcTimestamp>;

export const PrefixedId = z.string().min(1).max(36);
export type PrefixedId = z.infer<typeof PrefixedId>;

/**
 * 站内相对路径。服务端下发的 redirectTo / loginUrl / unlockUrl / sseUrl 全用它。
 * 拒绝 `//evil.com`（协议相对 URL）与 `/\evil.com`（部分浏览器等价于 `//`），
 * 否则深链回跳就是开放重定向钓鱼面。
 */
export const RelativePath = z
  .string()
  .max(2048)
  .regex(/^\/(?![/\\])/, '必须是站内相对路径（以单个 / 开头，不得是协议相对 URL）');
export type RelativePath = z.infer<typeof RelativePath>;

/**
 * 外部绝对 URL，只允许 http/https。素材来自外部抓取源，是不可信输入。
 * 协议判定用正则而非 `new URL()`：zod 的 `.url()` 失败只把状态置为 dirty，
 * refinement 仍会执行，`new URL('not a url')` 于是抛 TypeError，把 400 变成 500。
 */
export const HttpUrl = z
  .string()
  .url()
  .refine((u) => /^https?:\/\//i.test(u), {
    message: '只允许 http/https，拒绝 javascript: / data: 等可执行协议',
  });
export type HttpUrl = z.infer<typeof HttpUrl>;

/** 查询串布尔。z.coerce.boolean() 会把 "false" 变成 true，故只接受字面量。 */
export const QueryBoolean = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true');
export type QueryBoolean = z.infer<typeof QueryBoolean>;

/**
 * 配额（架构 §7.1）。恒等式 left = total - used - reserved 在契约层即校验，
 * 任何一侧算错都会在边界被拒，而不是等到 UI 出现三处数字不一致（D-22）。
 */
export const QuotaSchema = z
  .object({
    total: z.number().int().min(0),
    used: z.number().int().min(0),
    reserved: z.number().int().min(0),
    left: z.number().int().min(0),
    resetAt: UtcTimestamp,
  })
  .refine((q) => q.left === q.total - q.used - q.reserved, {
    message: '配额恒等式被破坏：left 必须等于 total - used - reserved',
    path: ['left'],
  })
  .refine((q) => q.used + q.reserved <= q.total, {
    message: '超支：used + reserved 不得大于 total',
    path: ['reserved'],
  })
  // refine 无法表达为 JSON Schema，故把不变量写进 description，OpenAPI 消费者才看得到 D-22。
  .describe(
    '配额不变量（D-22）：left = total - used - reserved，且 used + reserved <= total。' +
      '三条数字必须同源于一份账本聚合，禁止各端各算。',
  );
export type Quota = z.infer<typeof QuotaSchema>;

export const GatesSchema = z.object({
  G1: z.boolean(),
  G2: z.boolean(),
  G3: z.boolean(),
  G4: z.boolean(),
});
export type Gates = z.infer<typeof GatesSchema>;

/**
 * 闸门未满足原因。逐条对应架构 §5.2 deriveGates 的判定分支，
 * 前端按 reason 选择修复 UI，不解析 message（架构 §10.1）。
 */
export const GateReason = z.enum([
  'TOPIC_NOT_SELECTED',
  'SCRIPT_NOT_CONFIRMED',
  'HD_RENDER_NOT_SUCCEEDED',
  'HD_ASSET_STALE',
  'HD_ASSET_SCRIPT_VERSION_MISMATCH',
  'COMPLIANCE_REPORT_MISSING',
  'COMPLIANCE_BLOCKING',
  'COMPLIANCE_FINGERPRINT_STALE',
]);
export type GateReason = z.infer<typeof GateReason>;

export const GateDetailSchema = z.object({
  satisfied: z.boolean(),
  reason: GateReason.optional(),
  redirectTo: RelativePath,
  activeJobId: PrefixedId.optional(),
});
export type GateDetail = z.infer<typeof GateDetailSchema>;

export const GateDetailsSchema = z.object({
  G1: GateDetailSchema.optional(),
  G2: GateDetailSchema.optional(),
  G3: GateDetailSchema.optional(),
  G4: GateDetailSchema.optional(),
});
export type GateDetails = z.infer<typeof GateDetailsSchema>;

/**
 * D-07：渲染等待期的并行 CTA（架构 §5.6）。
 * 禁用态没有落地页，domain 用空串表达「无处可去」。空串不是重定向，不构成开放重定向面，
 * 因此只放行 enabled=false 时的空串；enabled=true 仍必须是站内相对路径。
 */
export const ParallelHintSchema = z
  .object({
    enabled: z.boolean(),
    cta: z.string(),
    redirectTo: z.union([z.literal(''), RelativePath]),
  })
  .refine((h) => !h.enabled || h.redirectTo !== '', {
    message: '启用并行 CTA 时必须给出站内落地页',
    path: ['redirectTo'],
  });
export type ParallelHint = z.infer<typeof ParallelHintSchema>;

/** 架构 §4.3 compliance_report.items 的 JSON 元素形状。 */
export const ComplianceItemSchema = z.object({
  kind: ComplianceKind,
  status: ComplianceState,
  detail: z.string(),
  blocking: z.boolean(),
  materialIds: z.array(PrefixedId).default([]),
  lineId: PrefixedId.optional(),
  fixHint: z.string().optional(),
});
export type ComplianceItem = z.infer<typeof ComplianceItemSchema>;

export const ComplianceReportSchema = z.object({
  id: PrefixedId,
  workId: PrefixedId,
  items: z.array(ComplianceItemSchema),
  blockingCount: z.number().int().min(0),
  warnCount: z.number().int().min(0),
  fingerprint: z.string().length(64),
  checkedAt: UtcTimestamp,
});
export type ComplianceReport = z.infer<typeof ComplianceReportSchema>;

/**
 * 闸门派生的唯一输入（架构 §5.3「单次聚合查询」）。
 * 权威判定永远由 domain.deriveGates 从本快照重算，work.gates 只是读缓存。
 */
export const WorkTruthSnapshotSchema = z.object({
  workId: PrefixedId,
  selectedTopicId: PrefixedId.nullable(),
  script: z
    .object({
      id: PrefixedId,
      version: z.number().int().min(0),
      status: ScriptStatus,
      confirmedAt: UtcTimestamp.nullable(),
      contentHash: z.string(),
    })
    .nullable(),
  latestHdAsset: z
    .object({
      id: PrefixedId,
      status: JobStatus,
      stale: z.boolean(),
      scriptVersion: z.number().int().min(0),
    })
    .nullable(),
  latestCompliance: z
    .object({
      blockingCount: z.number().int().min(0),
      fingerprint: z.string().length(64),
    })
    .nullable(),
  /** §8.4 指纹输入：引用素材及授权态。 */
  materials: z.array(
    z.object({
      materialId: PrefixedId,
      license: LicenseState,
      licenseEvidenceVersion: z.number().int().min(0),
    }),
  ),
  /** §8.4 指纹输入：派生与规则版本。 */
  derivatives: z.array(
    z.object({
      platformId: PlatformId,
      ruleVersion: z.number().int().min(0),
      title: z.string(),
      tags: z.array(z.string()),
    }),
  ),
  /** §8.4 指纹输入：模板与字体。 */
  template: z
    .object({
      templateId: PrefixedId,
      version: z.number().int().min(0),
      fontFamily: z.string(),
    })
    .nullable(),
  /** §8.4 指纹输入：背景音乐授权。 */
  bgm: z
    .object({
      trackId: PrefixedId,
      evidenceExpiresAt: UtcTimestamp.nullable(),
    })
    .nullable(),
  /** §8.4 指纹输入：敏感词库版本。 */
  lexiconVersion: z.number().int().min(0),
});
export type WorkTruthSnapshot = z.infer<typeof WorkTruthSnapshotSchema>;

/**
 * work 相关响应的统一信封（架构 §5.6 / §10.1）。
 * 前端一次拿到 gates/step/progress/quota 全部真相，杜绝三处额度不同源（AC-H3）。
 */
export const WorkEnvelopeSchema = z
  .object({
    id: PrefixedId,
    title: z.string(),
    keyword: z.string(),
    phase: Phase,
    step: WorkStep,
    progress: z.number().int().min(0).max(100),
    gates: GatesSchema,
    gateDetails: GateDetailsSchema,
    selectedTopicId: PrefixedId.nullable(),
    scriptConfirmedAt: UtcTimestamp.nullable(),
    activeRenderJobId: PrefixedId.nullable(),
    parallelHint: ParallelHintSchema,
    quota: QuotaSchema,
  })
  /**
   * gates 与 gateDetails 必须同源。不变量（逐门）：
   *   gates[g] === false  ⟺  gateDetails[g] 存在且 satisfied === false
   *
   * 为什么必须拦在契约层：前端 gateViewOf 把「缺详情」读成已满足
   * （架构 §5.6「只装未满足的门」的正确读法）。于是 gates[g]=false 而详情缺失的
   * 漂移响应会让未满足的门渲染成已解锁——D-04 根因形状从契约缺口重新长出来。
   * 服务端仍是闸门权威（G1–G5 服务端强制），故这不是提权；但用户会看到已解锁页面、
   * 填完表单才吃 409，且「首帧即锁定态」的验收静默失效。
   * 前端无法自救：读 gates 布尔位违反 D-04，自拼落地页违反「一律用服务端 redirectTo」。
   *
   * gates[g]=true 时**允许**详情存在，但 satisfied 必须为 true。架构 §5.6 只有示例
   * （arch:1235-1238）而无「必须缺席」的明文，domain 的 deriveGateDetails 也从不产出
   * 已满足门的详情；凭空禁止会发明未经裁决的形状收紧。矛盾态（true + satisfied:false）
   * 则必须拒：两个字段互相打架，前端会过度上锁。
   *
   * path 指向 gateDetails[g] 而非 gates[g]：gates 是 deriveGates 的读缓存、
   * 每个布尔位单独看都合法，缺的是**派生详情**；生产者的修复动作是补齐/改正该门的详情，
   * 错误路径就落在要动手的那个键上。用 superRefine 而非 refine，是为了逐门定位并
   * 一次报出所有漂移门。message 只含门号与不一致性质，绝不回写 details 内容
   * （reason/redirectTo/activeJobId 可能含业务信息，且前端按 code 分支不按 message）。
   */
  .superRefine((env, ctx) => {
    // 从 GatesSchema 取键，避免第二份硬编码门列表漂移；G5 天然不在其中。
    for (const gate of GatesSchema.keyof().options) {
      const satisfied = env.gates[gate];
      const detail = env.gateDetails[gate];
      if (!satisfied && detail == null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['gateDetails', gate],
          message: `门 ${gate} 未满足（gates.${gate}=false）但 gateDetails.${gate} 缺失：缺详情会被前端读成已满足`,
        });
      } else if (detail != null && detail.satisfied !== satisfied) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['gateDetails', gate],
          message: `门 ${gate} 的 gates.${gate} 与 gateDetails.${gate}.satisfied 不一致`,
        });
      }
    }
  })
  // 同 QuotaSchema：superRefine 无法表达为 JSON Schema，故把不变量写进 description，
  // OpenAPI 消费者才看得到这条一致性约束（zod-only 约束的可见性补偿）。
  .describe(
    'Work 统一信封。闸门一致性不变量：对每个门 g，gates[g]=false 当且仅当 gateDetails[g] 存在且 satisfied=false。' +
      'gates[g]=true 时详情可缺席；若存在则 satisfied 必须为 true。' +
      'gateDetails 只装未满足的门，前端把缺详情读作已满足，故漂移响应一律拒绝。',
  );
export type WorkEnvelope = z.infer<typeof WorkEnvelopeSchema>;

/** 门 → 详情键的类型安全映射，供 Guard 与前端共用。 */
export type GateDetailKey = z.infer<typeof GateId>;