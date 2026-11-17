import { StateActions, StateShell } from './StateShell';
import {
  PARTIAL_STATUS_LABEL,
  partialCounts,
  partialItemAction,
  partialSummaryText,
  partialTitle,
  partialTone,
} from './partial';
import type { PartialItem } from './partial';
import type { PresentationLevel, StateAction } from './types';

export type { PartialItem } from './partial';

export interface PartialSuccessStateProps {
  items: readonly PartialItem[];
  title?: string;
  summary?: string;
  /** 整体动作，例如「重试全部失败项」「成功项先导出」。 */
  actions?: readonly StateAction[];
  /** 没给 item.action 时的逐项重试回调。 */
  onRetryItem?: (item: PartialItem) => void;
  itemActionLabel?: string;
  level?: PresentationLevel;
  className?: string;
  testId?: string;
}

/**
 * 部分成功态：逐项标记 + 逐项恢复（SPEC §9：单类失败该列错误态、部分 hunk 单独重试、
 * 单平台失败单独重派生、导入部分失败逐条标记、成功项先导）。
 */
export function PartialSuccessState({
  items,
  title,
  summary,
  actions,
  onRetryItem,
  itemActionLabel = '重试',
  level = 'section',
  className,
  testId,
}: PartialSuccessStateProps) {
  const counts = partialCounts(items);
  return (
    <StateShell
      tone={partialTone(counts)}
      level={level}
      title={title ?? partialTitle(counts)}
      description={summary ?? partialSummaryText(counts)}
      actions={actions}
      className={['ks-partial', className].filter(Boolean).join(' ')}
      testId={testId}
    >
      <ul className="ks-partial__list">
        {items.map((item) => {
          const action = partialItemAction(item, onRetryItem, itemActionLabel);
          return (
            <li key={item.key} className="ks-partial__item" data-status={item.status}>
              <span className="ks-partial__badge">{PARTIAL_STATUS_LABEL[item.status]}</span>
              <span className="ks-partial__label">{item.label}</span>
              {item.detail == null || item.detail === '' ? null : (
                <span className="ks-partial__detail">{item.detail}</span>
              )}
              {action == null ? null : <StateActions actions={[action]} />}
            </li>
          );
        })}
      </ul>
    </StateShell>
  );
}