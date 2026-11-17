import type { ConnectivityPort, DraftEnvelope, DraftInput, DraftPort } from './ports';
import type { StateTone } from './types';

/**
 * 离线横幅的状态机（SPEC §9 全局：离线 → 顶部横幅 + 本地暂存，恢复后同步）。
 *
 * 刻意与 React 解耦：纯 TypeScript + 注入端口，可在 node 环境确定性单测。
 * 也刻意**不含任何定时器**：不自动轮询、不自动重试，重试是用户显式动作，
 * 免得单测要假时钟，也免得后台偷偷重放用户的编辑。
 *
 * 存储实现不在这里（T-16）：本状态机只负责在正确时机调用 DraftPort。
 */

export type OfflinePhase = 'online' | 'offline' | 'syncing' | 'sync-failed' | 'synced';

export interface OfflineState {
  online: boolean;
  phase: OfflinePhase;
  /** 断网瞬间的输入是否已成功交给 DraftPort。 */
  stashed: boolean;
  /** 暂存写入是否在飞行中。缺了它，「还没落盘」会被误读成「没有改动」（P2）。 */
  stashing: boolean;
  /** 暂存本身失败（例如 IndexedDB 被禁用/配额满）。必须让用户知道，不能假装已保存。 */
  stashFailed: boolean;
  /** 本机是否还留着未清理的暂存副本。 */
  pending: boolean;
  syncAttempt: number;
}

export interface OfflineControllerOptions {
  connectivity: ConnectivityPort;
  draftPort?: DraftPort;
  draftKey?: string;
  collectDraft?: () => DraftInput | null;
  /** 恢复联网后的同步回调。draft 为 null 表示本机没有暂存，屏可据此只做重新拉取。 */
  sync?: (draft: DraftEnvelope | null) => Promise<void> | void;
  now?: () => string;
}

export interface OfflineController {
  getState(): OfflineState;
  subscribe(listener: () => void): () => void;
  start(): void;
  stop(): void;
  retry(): void;
  dismiss(): void;
}

export function createOfflineController(options: OfflineControllerOptions): OfflineController {
  const { connectivity, draftPort, draftKey, collectDraft, sync } = options;
  const now = options.now ?? ((): string => new Date().toISOString());
  const listeners = new Set<() => void>();
  const canStash = draftPort != null && draftKey != null;

  let unsubscribe: (() => void) | null = null;
  /** 代际号：联网状态一变就自增，飞行中的异步结果一律作废，避免旧结果覆盖新状态。 */
  let generation = 0;
  /**
   * 暂存写入链：同一 key 的 save 串行排队，runSync 读之前必须等它落盘。
   * 代际号只能作废「过期状态更新」，管不住「已落盘的副作用」；
   * 不等这条链就 load，会在 save 飞行中读到 null，把离线编辑静默丢掉（P1 竞态）。
   */
  let stashChain: Promise<void> = Promise.resolve();

  const initialOnline = connectivity.isOnline();
  let state: OfflineState = {
    online: initialOnline,
    phase: initialOnline ? 'online' : 'offline',
    stashed: false,
    stashing: false,
    stashFailed: false,
    pending: false,
    syncAttempt: 0,
  };

  const set = (patch: Partial<OfflineState>): void => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };

  const stash = async (): Promise<void> => {
    if (draftPort == null || draftKey == null || collectDraft == null) return;
    const gen = generation;
    try {
      const input = collectDraft();
      if (input == null) {
        set({ stashed: false, stashing: false, stashFailed: false });
        return;
      }
      const envelope: DraftEnvelope = {
        key: draftKey,
        savedAt: now(),
        payload: input.payload,
        ...(input.baseVersion == null ? {} : { baseVersion: input.baseVersion }),
      };
      await draftPort.save(envelope);
      if (gen !== generation) return;
      set({ stashed: true, stashing: false, stashFailed: false, pending: true });
    } catch {
      if (gen !== generation) return;
      set({ stashed: false, stashing: false, stashFailed: true });
    }
  };

  /** 唯一的暂存入口：排队进写入链，并先把「正在暂存」暴露给横幅。 */
  const startStash = (): void => {
    if (!canStash || draftPort == null || draftKey == null || collectDraft == null) return;
    set({ stashing: true });
    stashChain = stashChain.then(() => stash());
  };

  const runSync = async (): Promise<void> => {
    const gen = (generation += 1);
    set({ phase: 'syncing', stashing: false });
    try {
      // 先等飞行中的暂存落盘再读，否则 load 读到 null，离线编辑就没上传（P1 竞态）。
      await stashChain;
      if (gen !== generation || !state.online) return;
      const draft =
        draftPort != null && draftKey != null ? await draftPort.load(draftKey) : null;
      if (gen !== generation || !state.online) return;
      await sync?.(draft);
      if (gen !== generation || !state.online) return;
      // 同步成功后才清副本；清理失败不算同步失败（数据已经上去了），但要如实留下 pending。
      let cleared = true;
      if (draft != null && draftPort != null && draftKey != null) {
        try {
          await draftPort.clear(draftKey);
        } catch {
          cleared = false;
        }
      }
      if (gen !== generation || !state.online) return;
      set({ phase: 'synced', pending: !cleared, stashed: false, stashFailed: false });
    } catch {
      if (gen !== generation || !state.online) return;
      // 失败绝不清副本：内容留在本机，等用户显式重试。
      set({ phase: 'sync-failed', syncAttempt: state.syncAttempt + 1 });
    }
  };

  const onChange = (online: boolean): void => {
    if (online === state.online) return;
    generation += 1;
    if (online) {
      set({ online: true, phase: 'syncing', stashFailed: false });
      void runSync();
    } else {
      set({ online: false, phase: 'offline', stashed: false, stashFailed: false });
      startStash();
    }
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start: () => {
      if (unsubscribe != null) return;
      const online = connectivity.isOnline();
      if (online !== state.online) onChange(online);
      else if (!online) startStash();
      unsubscribe = connectivity.subscribe(onChange);
    },
    stop: () => {
      generation += 1;
      unsubscribe?.();
      unsubscribe = null;
    },
    retry: () => {
      if (state.phase === 'sync-failed' && state.online) void runSync();
      else if (!state.online && state.stashFailed) startStash();
    },
    dismiss: () => {
      if (state.phase === 'synced') set({ phase: 'online' });
    },
  };
}

export interface OfflineCopy {
  tone: StateTone;
  text: string;
  /** 有数据风险的两种情况用 alert，其余用 status，避免刷屏（架构 §11.5）。 */
  role: 'status' | 'alert';
}

/**
 * 横幅文案选择：纯函数，可单测。
 * 诚实性约束：**没有接暂存端口时不得声称「已暂存」**，暂存失败时必须明说失败。
 */
export function offlineCopy(state: OfflineState, hasDraftPort: boolean): OfflineCopy {
  switch (state.phase) {
    case 'online':
      return { tone: 'neutral', text: '', role: 'status' };
    case 'offline':
      if (state.stashing)
        return {
          tone: 'info',
          text: '网络已断开，正在把改动暂存到本机…',
          role: 'status',
        };
      if (state.stashFailed)
        return {
          tone: 'danger',
          text: '网络已断开，本地暂存也失败了。请先把重要内容复制出来，别关掉页面。',
          role: 'alert',
        };
      if (state.stashed)
        return {
          tone: 'warning',
          text: '网络已断开。编辑内容已暂存在本机，恢复联网后会自动同步。',
          role: 'status',
        };
      if (hasDraftPort)
        return {
          tone: 'warning',
          text: '网络已断开。当前没有需要暂存的改动，恢复联网后会自动同步。',
          role: 'status',
        };
      return {
        tone: 'warning',
        text: '网络已断开，改动暂时无法保存到服务器。恢复联网后会重新同步。',
        role: 'status',
      };
    case 'syncing':
      return { tone: 'info', text: '网络已恢复，正在同步本地改动…', role: 'status' };
    case 'sync-failed':
      return {
        tone: 'danger',
        text: '网络已恢复，但本地改动同步失败。内容还在本机，可以重试。',
        role: 'alert',
      };
    case 'synced':
      if (!hasDraftPort) return { tone: 'success', text: '网络已恢复。', role: 'status' };
      return {
        tone: 'success',
        text: state.pending
          ? '本地改动已同步，但本机副本没清掉，下次联网会再同步一次。'
          : '网络已恢复，本地改动已同步。',
        role: 'status',
      };
  }
}