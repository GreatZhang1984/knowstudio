import type { QueryClient } from '@tanstack/react-query';
import type { GateDetail, GateId, WorkEnvelope, WorkListItem } from '@knowstudio/contracts';
import { fetchRecentWork, fetchWorkEnvelope } from './api';
import { workKeys } from './queries';

/**
 * 架构 §5.5 第一层「路由 loader」：进入受门控的深链**之前**先取服务端信封。
 *
 * 为什么要提到 loader：组件级包装要等路由元素渲染后才开始取数，
 * 深链会先画一帧骨架/内容再翻成锁定态。放进 loader 后，
 * React Router 在导航提交前就把信封取回来，元素首帧读到的就是缓存里的终态，不再有中间帧。
 *
 * 这里**不推导任何闸门布尔值**：只读服务端已经判好的 gateDetails[gate]。
 * 不 import deriveGates / checkGate，也不读 envelope.gates 的布尔位（D-04 根因）。
 */
export type GateView =
  | { kind: 'ready' }
  | { kind: 'locked'; requiredGate: GateId; redirectTo: string; detail: GateDetail };

/**
 * 信封 → 视图判定。loader 与组件级兜底共用这一个函数，两条路径不可能判出不同结果。
 *
 * gateDetails 只装未满足的门（架构 §5.6）：缺详情即视为已满足。
 * 落地页一律取 detail.redirectTo，不在前端拼「上一门」的路径。
 */
export function gateViewOf(envelope: WorkEnvelope, gate: GateId): GateView {
  const detail = envelope.gateDetails[gate];
  if (detail == null || detail.satisfied) return { kind: 'ready' };
  return { kind: 'locked', requiredGate: gate, redirectTo: detail.redirectTo, detail };
}

/**
 * 预取信封。**失败不在 loader 里抛**：抛出去会被 errorElement 接走整页，
 * 而我们要的是页面内的「取不到作品状态」错误态（组件级兜底统一渲染）。
 * 失败结果同样落在 Query 缓存里，兜底组件读到的就是 isError。
 */
export async function prefetchWorkEnvelope(
  queryClient: QueryClient,
  workId: string | undefined,
): Promise<WorkEnvelope | null> {
  if (workId == null || workId.length === 0) return null;
  try {
    return await queryClient.ensureQueryData({
      queryKey: workKeys.envelope(workId),
      queryFn: () => fetchWorkEnvelope(workId),
    });
  } catch {
    return null;
  }
}

/** 域入口 `/studio` `/publish` 的预取：先把「最近活跃 Work」取回来，重定向就没有中间帧。 */
export async function prefetchRecentWork(queryClient: QueryClient): Promise<WorkListItem | null> {
  try {
    return await queryClient.ensureQueryData({
      queryKey: workKeys.recent,
      queryFn: fetchRecentWork,
    });
  } catch {
    return null;
  }
}