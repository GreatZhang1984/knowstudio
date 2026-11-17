import type { StateAction } from './types';

/** 部分成功态的计数、文案与逐项动作：纯函数，可单测（SPEC §9 部分成功列）。 */

export type PartialItemStatus = 'success' | 'failed' | 'skipped';

export interface PartialCounts {
  total: number;
  success: number;
  failed: number;
  skipped: number;
}

export interface PartialItemLike {
  status: PartialItemStatus;
}

export interface PartialItem extends PartialItemLike {
  key: string;
  label: string;
  /** 逐项说明，例如失败原因或产物地址。由屏提供，通用组件不猜。 */
  detail?: string;
  /** 逐项动作（单独重试 / 单独重派生 / 先下载成功项）。 */
  action?: StateAction;
}

export function partialCounts(items: readonly PartialItemLike[]): PartialCounts {
  let success = 0;
  let failed = 0;
  let skipped = 0;
  for (const item of items) {
    if (item.status === 'success') success += 1;
    else if (item.status === 'failed') failed += 1;
    else skipped += 1;
  }
  return { total: items.length, success, failed, skipped };
}

export function partialTone(counts: PartialCounts): 'success' | 'warning' | 'danger' {
  if (counts.total === 0) return 'warning';
  if (counts.failed === 0 && counts.skipped === 0) return 'success';
  if (counts.success === 0) return 'danger';
  return 'warning';
}

export function partialTitle(counts: PartialCounts): string {
  if (counts.total === 0) return '没有可处理的项目';
  if (counts.failed === 0 && counts.skipped === 0) return '全部完成';
  if (counts.success === 0) return '全部失败';
  return '部分完成';
}

export function partialSummaryText(counts: PartialCounts): string {
  const parts = [`成功 ${counts.success}`, `失败 ${counts.failed}`];
  if (counts.skipped > 0) parts.push(`跳过 ${counts.skipped}`);
  return `共 ${counts.total} 项：${parts.join('、')}。`;
}

export const PARTIAL_STATUS_LABEL: Record<PartialItemStatus, string> = {
  success: '成功',
  failed: '失败',
  skipped: '已跳过',
};

/**
 * 逐项动作解析：屏显式给的 action 优先，其次才是「失败项自动挂重试」。
 * 抽成纯函数，回调是否真的接上可以在单测里直接调用验证。
 */
export function partialItemAction(
  item: PartialItem,
  onRetryItem?: (item: PartialItem) => void,
  label = '重试',
): StateAction | undefined {
  if (item.action != null) return item.action;
  if (item.status !== 'failed' || onRetryItem == null) return undefined;
  return { key: `${item.key}-retry`, label, onClick: () => onRetryItem(item) };
}