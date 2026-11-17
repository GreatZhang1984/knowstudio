import type { ApiError, GateDetail } from '@knowstudio/contracts';
import { GateLocked } from '../GateLocked';
import { recoveryToActions } from './actions';
import { resolveErrorUi } from './error-map';
import { StateShell } from './StateShell';
import type {
  ErrorUiContext,
  PresentationLevel,
  RecoveryAction,
  StateAction,
  StateTone,
} from './types';

export interface ErrorStateProps {
  /** 契约错误信封。分支只看 code（架构 §10.2），message 仅作兜底展示。 */
  error?: ApiError;
  /** 无契约错误时（断网、未知异常）由屏传入文案。 */
  title?: string;
  description?: string;
  tone?: StateTone;
  /** 覆盖默认呈现级别：整页错误在卡片里可降级为 section（SPEC §9 各屏错误列）。 */
  level?: PresentationLevel;
  context?: ErrorUiContext;
  /** 屏自己的动作，排在恢复动作之后。 */
  actions?: readonly StateAction[];
  onRecovery?: (action: RecoveryAction) => void;
  /** 附加提示，例如 SPEC §9 视频预览「渲染失败 → 重试 + 额度已退」。 */
  notice?: string;
  /** 服务端信封里的 gateDetails[requiredGate]，透传给既有 GateLocked（T-15）。 */
  gateDetail?: GateDetail;
  headingLevel?: 2 | 3 | 4;
  className?: string;
  testId?: string;
}

/**
 * 错误态。两种用法：
 * 1. 传 `error`：标题/文案/呈现级别/恢复动作全部由 ERROR_UI 按 code 派生；
 * 2. 传 `title`/`description`：屏自己的非契约错误（断网、超时、业务失败）。
 * 两者可叠加：props 覆盖映射结果，便于同一屏做局部降级。
 */
export function ErrorState({
  error,
  title,
  description,
  tone,
  level,
  context,
  actions,
  onRecovery,
  notice,
  gateDetail,
  headingLevel,
  className,
  testId,
}: ErrorStateProps) {
  const resolved = error == null ? undefined : resolveErrorUi(error, context ?? {});
  const effectiveLevel = level ?? resolved?.level ?? 'section';
  const recovery = resolved == null ? [] : recoveryToActions(resolved.actions, onRecovery);
  const allActions = [...recovery, ...(actions ?? [])];

  // 闸门错误在整页呈现时直接复用既有 GateLocked，避免第二份闸门文案。
  // 屏把 level 降级为 section/inline 时走通用外壳（例如派生页里的一块锁定区）。
  if (resolved?.gate != null && effectiveLevel === 'page') {
    const gate = resolved.gate;
    return (
      <div className={['ks-error', className].filter(Boolean).join(' ')} data-testid={testId}>
        <GateLocked
          requiredGate={gate.requiredGate}
          redirectTo={gate.redirectTo}
          detail={gateDetail}
          onNavigate={
            onRecovery == null
              ? undefined
              : (path) => onRecovery({ kind: 'navigate', label: '回到上一门', to: path })
          }
        />
        {notice == null || notice === '' ? null : <p className="ks-state__notice">{notice}</p>}
      </div>
    );
  }

  return (
    <StateShell
      tone={tone ?? resolved?.tone ?? 'danger'}
      level={effectiveLevel}
      title={title ?? resolved?.title ?? '出了点问题'}
      description={description ?? resolved?.body}
      notice={notice}
      actions={allActions}
      headingLevel={headingLevel}
      className={['ks-error', className].filter(Boolean).join(' ')}
      testId={testId}
    />
  );
}