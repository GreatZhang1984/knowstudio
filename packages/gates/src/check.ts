import type {
  ApiErrorFor,
  DeriveScope,
  GateId,
  Gates,
  WorkTruthSnapshot,
} from '@knowstudio/contracts';
import {
  deriveGateDetails,
  deriveGates,
  requiredGate,
  type GateAction,
} from '@knowstudio/domain';

export type GateDenied = ApiErrorFor<'GATE_NOT_SATISFIED'>;

export type GateCheckResult =
  | { ok: true; gates: Gates }
  | { ok: false; gates: Gates; status: 409; error: GateDenied };

/**
 * GateGuard 的判定核心（架构 §5.3）。纯函数、零 IO：
 * 快照由调用方一次聚合查询取得，这里只负责判定与构造 409 契约。
 * 绝不接受客户端传来的 gates / reportId 作为放行依据（D-04 根因）。
 */
export function checkGateById(
  s: WorkTruthSnapshot,
  gate: GateId,
  activeRenderJobId: string | null = null,
): GateCheckResult {
  const gates = deriveGates(s);
  if (gates[gate]) return { ok: true, gates };

  const detail = deriveGateDetails(s, gates, activeRenderJobId)[gate];
  return {
    ok: false,
    gates,
    status: 409,
    error: {
      code: 'GATE_NOT_SATISFIED',
      message: `人工把关门 ${gate} 未满足`,
      details: {
        requiredGate: gate,
        redirectTo: detail?.redirectTo ?? '',
        reason: detail?.reason ?? 'SCRIPT_NOT_CONFIRMED',
      },
    },
  };
}

export function checkGate(
  s: WorkTruthSnapshot,
  action: GateAction,
  scope: DeriveScope = 'media',
  activeRenderJobId: string | null = null,
): GateCheckResult {
  return checkGateById(s, requiredGate(action, scope), activeRenderJobId);
}