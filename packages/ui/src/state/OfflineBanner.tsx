import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { Button } from 'antd';
import { createOfflineController, offlineCopy } from './offline';
import { browserConnectivity } from './ports';
import type { ConnectivityPort, DraftEnvelope, DraftInput, DraftPort } from './ports';

export interface OfflineBannerProps {
  /** 默认用 navigator.onLine + online/offline 事件；测试与其它宿主可注入。 */
  connectivity?: ConnectivityPort;
  /**
   * 暂存端口。**T-08 只定义接口，不实现存储**；T-16 注入 IndexedDB 实现。
   * 不传时横幅照常提示离线，但不会声称「已暂存」。
   */
  draftPort?: DraftPort;
  draftKey?: string;
  /** 断网瞬间由屏交出当前输入（编辑器内容 + baseVersion）。 */
  collectDraft?: () => DraftInput | null;
  /** 恢复联网后的同步回调。draft=null 表示本机无暂存，屏可只做重新拉取。 */
  onSync?: (draft: DraftEnvelope | null) => Promise<void> | void;
  onDismiss?: () => void;
  className?: string;
  testId?: string;
}

/**
 * 离线横幅（SPEC §9 全局规则）。联网状态监听 + 断网暂存 + 恢复后同步。
 * 状态机在 offline.ts（纯逻辑、可单测），这里只负责订阅与渲染。
 */
export function OfflineBanner({
  connectivity,
  draftPort,
  draftKey,
  collectDraft,
  onSync,
  onDismiss,
  className,
  testId,
}: OfflineBannerProps) {
  // 回调走 ref：屏通常传内联函数，若进 useMemo 依赖会导致每次渲染重建控制器、反复重订阅。
  const handlers = useRef({ collectDraft, onSync });
  handlers.current = { collectDraft, onSync };

  const controller = useMemo(
    () =>
      createOfflineController({
        connectivity: connectivity ?? browserConnectivity,
        draftPort,
        draftKey,
        collectDraft: () => handlers.current.collectDraft?.() ?? null,
        sync: async (draft) => {
          await handlers.current.onSync?.(draft);
        },
      }),
    [connectivity, draftPort, draftKey],
  );

  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);

  useEffect(() => {
    controller.start();
    return () => controller.stop();
  }, [controller]);

  if (state.phase === 'online') return null;

  const canStash = draftPort != null && draftKey != null && collectDraft != null;
  const copy = offlineCopy(state, canStash);
  const canRetry = state.phase === 'sync-failed' || (state.phase === 'offline' && state.stashFailed);

  return (
    <div
      className={['ks-offline', className].filter(Boolean).join(' ')}
      data-tone={copy.tone}
      data-phase={state.phase}
      data-testid={testId}
      role={copy.role}
      aria-live={copy.role === 'alert' ? 'assertive' : 'polite'}
    >
      <span className="ks-offline__dot" aria-hidden="true" />
      <p className="ks-offline__text">{copy.text}</p>
      {canRetry || state.phase === 'synced' ? (
        <div className="ks-offline__actions">
          {canRetry ? (
            <Button
              className="ks-state__btn"
              data-primary="true"
              onClick={() => controller.retry()}
            >
              重试
            </Button>
          ) : null}
          {state.phase === 'synced' ? (
            <Button
              className="ks-state__btn"
              onClick={() => {
                controller.dismiss();
                onDismiss?.();
              }}
            >
              知道了
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}