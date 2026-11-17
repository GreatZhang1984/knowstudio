import type {
  GateDetail,
  GateDetails,
  GateId,
  GateReason,
  Gates,
  ParallelHint,
  WorkTruthSnapshot,
} from '@knowstudio/contracts';
import { resumePath } from '../work/progress.js';
import { complianceFingerprint } from './fingerprint.js';

function g1Reason(s: WorkTruthSnapshot): GateReason | undefined {
  return s.selectedTopicId == null ? 'TOPIC_NOT_SELECTED' : undefined;
}

function g2Reason(s: WorkTruthSnapshot): GateReason | undefined {
  return s.script?.status === 'confirmed' && s.script.confirmedAt != null
    ? undefined
    : 'SCRIPT_NOT_CONFIRMED';
}

function g3Reason(s: WorkTruthSnapshot): GateReason | undefined {
  const a = s.latestHdAsset;
  if (a == null || a.status !== 'succeeded') return 'HD_RENDER_NOT_SUCCEEDED';
  if (a.stale) return 'HD_ASSET_STALE';
  if (a.scriptVersion !== s.script?.version) return 'HD_ASSET_SCRIPT_VERSION_MISMATCH';
  return undefined;
}

function g4Reason(s: WorkTruthSnapshot): GateReason | undefined {
  const c = s.latestCompliance;
  if (c == null) return 'COMPLIANCE_REPORT_MISSING';
  if (c.blockingCount > 0) return 'COMPLIANCE_BLOCKING';
  if (c.fingerprint !== complianceFingerprint(s)) return 'COMPLIANCE_FINGERPRINT_STALE';
  return undefined;
}

const REASONS: Record<GateId, (s: WorkTruthSnapshot) => GateReason | undefined> = {
  G1: g1Reason,
  G2: g2Reason,
  G3: g3Reason,
  G4: g4Reason,
};

/**
 * 每个门的修复入口。G3 在渲染在途时指向渲染进度页，否则指向视频页——
 * 架构 §5.6 示例中 activeJobId 与 redirectTo=/studio/w1/render 同时出现。
 *
 * G4 指向派生页，**绝不能指向 export 自身**：export 页就是 G4 的锁定对象，
 * 指向自身会让「回到上一门」CTA 原地死循环，用户永远跑不了第一次合规检查。
 * SPEC §2.3 的链路是 derive ──G4──> export，故上一门是 derive。
 */
function redirectFor(gate: GateId, s: WorkTruthSnapshot, activeJobId: string | null): string {
  switch (gate) {
    case 'G1':
      return resumePath('topics', s.workId);
    case 'G2':
      return resumePath('script', s.workId);
    case 'G3':
      return resumePath(activeJobId == null ? 'video.draft' : 'video.rendering', s.workId);
    case 'G4':
      return resumePath('derive', s.workId);
  }
}

/** 架构 §5.6：只下发未满足的门，前端据此渲染 GateLocked，不做本地布尔判断。 */
export function deriveGateDetails(
  s: WorkTruthSnapshot,
  gates: Gates,
  activeRenderJobId: string | null = null,
): GateDetails {
  const details: GateDetails = {};
  for (const gate of ['G1', 'G2', 'G3', 'G4'] as const) {
    if (gates[gate]) continue;
    const detail: GateDetail = {
      satisfied: false,
      reason: REASONS[gate](s),
      redirectTo: redirectFor(gate, s, activeRenderJobId),
    };
    if (gate === 'G3' && activeRenderJobId != null) detail.activeJobId = activeRenderJobId;
    details[gate] = detail;
  }
  return details;
}

/** D-07：渲染等待期把用户引去写平台标题，而不是干等（SPEC §1.4 的 60min 预算前提）。 */
export function deriveParallelHint(
  s: WorkTruthSnapshot,
  gates: Gates,
  activeRenderJobId: string | null,
): ParallelHint {
  const enabled = activeRenderJobId != null && gates.G2 && !gates.G3;
  return {
    enabled,
    cta: enabled ? '渲染时你可以先去写平台标题' : '',
    redirectTo: enabled ? resumePath('derive', s.workId) : '',
  };
}