import { formatWaitSeconds, loginTarget } from './format';
import type { RecoveryAction, StateAction } from './types';

/**
 * 恢复动作 → 通用按钮模型。纯函数，可单测。
 *
 * 通用组件不知道任何一屏的业务：它只把 kind 携带的载荷原样交回屏的 onRecovery。
 * 屏没接处理函数时按钮**禁用并说明原因**，而不是渲染一个点了没反应的按钮。
 */
export function recoveryToActions(
  actions: readonly RecoveryAction[],
  onRecovery?: (action: RecoveryAction) => void,
): StateAction[] {
  return actions.map((action, index) => {
    const href = hrefOf(action);
    const wired = onRecovery != null || href != null;
    return {
      key: `${index}-${action.kind}`,
      label: action.label,
      primary: index === 0,
      disabled: !wired,
      ...(wired ? {} : { disabledReason: '这个恢复动作还没有接上处理函数' }),
      ...(onRecovery != null ? { onClick: () => onRecovery(action) } : {}),
      ...(onRecovery == null && href != null ? { href } : {}),
    };
  });
}

/** 只有「跳转类」动作在没有回调时能退化为原生链接；其余必须由屏处理。 */
function hrefOf(action: RecoveryAction): string | undefined {
  switch (action.kind) {
    case 'navigate':
      return action.to;
    case 'relogin':
      return loginTarget(action.loginUrl, action.returnTo);
    default:
      return undefined;
  }
}

/** 重试类动作的等待提示。文案里已有等待时长时屏可不用它。 */
export function retryHintOf(action: RecoveryAction): string | undefined {
  if (action.kind !== 'retry' || action.retryAfterSec == null || action.retryAfterSec <= 0)
    return undefined;
  return `${formatWaitSeconds(action.retryAfterSec)}后可重试`;
}