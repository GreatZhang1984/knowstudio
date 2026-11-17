/**
 * Work 响应信封装配（架构 §5.6 / §10.1）。
 *
 * ## 三条不可让渡的口径
 * 1. **闸门布尔值一律派生**：`deriveGates(snapshot)` 是唯一权威（架构 §5.2）。
 *    绝不硬编码 `ok:true`，也不把客户端传来的 gates / reportId 当放行依据——那是 D-04 的根因。
 *    `work.gates` 只是读缓存，本装配**不读它**，一律从快照重算。
 * 2. **progress / phase 不入库**：由 `domain.progressOf(step)` / `phaseOf(step)` 确定性计算（D-02）。
 * 3. **redirectTo 一律来自 domain**：`deriveGateDetails` / `deriveParallelHint` 产出，
 *    不在 HTTP 层自拼路径。注意 G4 的 redirectTo 是派生页 `/publish/:id`，
 *    **不是** `/publish/:id/export`（后者是 G4 的锁定对象，指向自身会原地死循环）。
 *
 * 最后用 `WorkEnvelopeSchema.parse` 兜一道：该 schema 带逐门一致性 superRefine
 * （gates[g]=false ⟺ gateDetails[g] 存在且 satisfied=false）。任何漂移在此抛错，
 * 而不是把「未满足的门渲染成已解锁」的响应发给前端。
 */
import {
  WorkEnvelopeSchema,
  type Quota,
  type Gates,
  type WorkEnvelope,
  type WorkListItem,
  type WorkTruthSnapshot,
} from '@knowstudio/contracts';
import {
  deriveGateDetails,
  deriveGates,
  deriveParallelHint,
  phaseOf,
  progressOf,
} from '@knowstudio/domain';
import type { WorkRow } from '@knowstudio/db/repositories';

/** DATETIME(3) 的 UTC 字面量（WP10 dateStrings:true + 会话 time_zone='+00:00'）。 */
const DB_UTC_LITERAL = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/;

export class WorkTimestampInvalidError extends Error {
  readonly code = 'WORK_TIMESTAMP_INVALID';
  constructor(readonly raw: string) {
    super('work 时间列不是 DATETIME(3) UTC 字面量，拒绝下发歧义时间');
    this.name = 'WorkTimestampInvalidError';
  }
}

/**
 * DB UTC 字面量 → RFC3339 UTC（架构 §10.1「时间一律 RFC3339 UTC」）。
 * 刻意只做「换分隔符 + 补 Z」，**不经过 new Date()**：驱动已按 UTC 字面量进出，
 * 再走一次 Date 会把宿主本地时区引进来，正是 WP10 选 dateStrings 要消灭的漂移。
 */
export function toRfc3339(literal: string): string {
  if (!DB_UTC_LITERAL.test(literal)) throw new WorkTimestampInvalidError(literal);
  return `${literal.replace(' ', 'T')}Z`;
}

/** 从快照派生闸门。抽出来是为了让列表与详情走**同一条**派生路径，不出现第二份判定。 */
export function gatesOf(snapshot: WorkTruthSnapshot): Gates {
  return deriveGates(snapshot);
}

/** 装配完整信封（POST /works、GET /works/:id、PATCH /works/:id 共用）。 */
export function assembleWorkEnvelope(
  work: WorkRow,
  snapshot: WorkTruthSnapshot,
  quota: Quota,
): WorkEnvelope {
  const gates = deriveGates(snapshot);
  const activeRenderJobId = work.active_render_job_id;

  return WorkEnvelopeSchema.parse({
    id: work.id,
    title: work.title,
    // 契约里 keyword 是 string（非 nullable），DB 列可空：空值下发空串，不下发 null。
    keyword: work.keyword ?? '',
    phase: phaseOf(work.step),
    step: work.step,
    progress: progressOf(work.step),
    gates,
    gateDetails: deriveGateDetails(snapshot, gates, activeRenderJobId),
    selectedTopicId: work.selected_topic_id,
    scriptConfirmedAt:
      work.script_confirmed_at === null ? null : toRfc3339(work.script_confirmed_at),
    activeRenderJobId,
    parallelHint: deriveParallelHint(snapshot, gates, activeRenderJobId),
    quota,
  });
}

/**
 * 列表项。gates 同样由快照派生（调用方传入已派生结果），
 * **不读 work.gates 缓存**：GateInvalidator 属后续 Task，缓存此刻不会被刷新，
 * 读它会让列表永久停在全 false。权威判定始终 deriveGates（架构 §5.2）。
 */
export function toWorkListItem(work: WorkRow, gates: Gates): WorkListItem {
  return {
    id: work.id,
    title: work.title,
    keyword: work.keyword ?? '',
    phase: phaseOf(work.step),
    step: work.step,
    progress: progressOf(work.step),
    gates,
    updatedAt: toRfc3339(work.updated_at),
  };
}