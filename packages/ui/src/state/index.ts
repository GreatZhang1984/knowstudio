/**
 * 异常态基座（T-08 / SPEC §9）。
 * 五个通用组件 + 错误码映射表 + 离线端口。组件不含任何一屏的业务，
 * 文案与恢复动作靠 props 传入；错误分支只看 contracts 的 code。
 */
import './state.css';

export { EmptyState } from './EmptyState';
export type { EmptyStateProps } from './EmptyState';
export { LoadingState } from './LoadingState';
export type { LoadingStateProps } from './LoadingState';
export { ErrorState } from './ErrorState';
export type { ErrorStateProps } from './ErrorState';
export { PartialSuccessState } from './PartialSuccessState';
export type { PartialItem, PartialSuccessStateProps } from './PartialSuccessState';
export { OfflineBanner } from './OfflineBanner';
export type { OfflineBannerProps } from './OfflineBanner';
export { StateShell, StateActions } from './StateShell';
export type { StateShellProps } from './StateShell';

export { ERROR_UI, isServerError, resolveErrorUi } from './error-map';
export { recoveryToActions, retryHintOf } from './actions';
export {
  PARTIAL_STATUS_LABEL,
  partialCounts,
  partialItemAction,
  partialSummaryText,
  partialTitle,
  partialTone,
} from './partial';
export type { PartialCounts, PartialItemLike, PartialItemStatus } from './partial';
export { SKELETON_VARIANTS, skeletonCount } from './skeleton';
export type { SkeletonVariant } from './skeleton';
export { createOfflineController, offlineCopy } from './offline';
export type {
  OfflineController,
  OfflineControllerOptions,
  OfflineCopy,
  OfflinePhase,
  OfflineState,
} from './offline';
export { browserConnectivity } from './ports';
export type { ConnectivityPort, DraftEnvelope, DraftInput, DraftPort } from './ports';
export {
  bodyOrMessage,
  formatBytes,
  formatTimestamp,
  formatWaitSeconds,
  loginTarget,
} from './format';
export type {
  ErrorUiContext,
  ErrorUiEntry,
  ErrorUiMap,
  FieldIssue,
  GateErrorInfo,
  PresentationLevel,
  QuotaOption,
  RecoveryAction,
  RecoveryKind,
  ResolvedErrorUi,
  StateAction,
  StateTone,
} from './types';