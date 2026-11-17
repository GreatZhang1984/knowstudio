import type { DeriveScope, GateId } from '@knowstudio/contracts';

/** 架构 §5.3 服务端校验点。门标注的权威来源，Guard 与前端深链防护共用。 */
export type GateAction =
  | 'script:generate'
  | 'video:draft'
  | 'video:render'
  | 'video:patch'
  | 'derivatives:generate'
  | 'derivatives:patch'
  | 'export';

const ROUTE_GATES = {
  'script:generate': 'G1',
  'video:draft': 'G2',
  'video:render': 'G2',
  'video:patch': 'G2',
  'derivatives:patch': 'G2',
  'export': 'G4',
} as const satisfies Record<Exclude<GateAction, 'derivatives:generate'>, GateId>;

/**
 * D-07 派生二分（A1 已拍板收窄）：metadata 只需 G2，media 需 G3。
 * 业务意图是「不能拿未渲染的母版去生成平台成片」，而非「渲染时不许写字」。
 * scope 缺省按 media 处理，与 GenerateDerivativesRequest 的默认值一致——
 * 漏传 scope 时宁可多校验一道门，不可少校验。
 */
export function requiredGate(action: GateAction, scope: DeriveScope = 'media'): GateId {
  if (action === 'derivatives:generate') return scope === 'metadata' ? 'G2' : 'G3';
  return ROUTE_GATES[action];
}

export const GATED_ACTIONS = [
  'script:generate',
  'video:draft',
  'video:render',
  'video:patch',
  'derivatives:generate',
  'derivatives:patch',
  'export',
] as const satisfies readonly GateAction[];