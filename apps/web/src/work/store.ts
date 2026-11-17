import { useEffect } from 'react';
import { createStore, useStore } from 'zustand';
import type { StoreApi } from 'zustand';

/**
 * 架构 §11.2「按 workId 隔离的状态管理」：每个 workId 一个独立 store 实例。
 *
 * 这里只放**编辑器瞬时状态**（光标、选区、undo 栈、未保存草稿）。
 * 服务端状态（gates/step/progress/quota/派生行）一律走 TanStack Query，
 * 不在分片里再存一份，否则又造出一个跨 work 的可变业务对象（D-01 / D-05 根因）。
 *
 * 新建 Work 走**新实例**，绝不 reset 旧实例：registry 里没有任何「全局当前 work」变量，
 * 也没有 resetAll 之类的批量清空入口，从结构上杜绝「新建作品带旧数据」。
 */

/** undo 栈上限：架构 §11.3 要求撤销 ≥20 步，取 20 同时给内存封顶。 */
export const UNDO_LIMIT = 20;

/**
 * 同时驻留的分片上限。
 *
 * 为什么要有上限：每片最多揣 20 份文案快照，文案按 SPEC §3.4 是几百到几千字，
 * 一片最坏 ~100KB 量级；不设上限的话「逛过多少个 Work」就等于「泄漏多少内存」，
 * 长会话（作品列表来回点）会单调增长。
 *
 * 为什么取 8：首页进行中作品是 3 列卡片，真实会话同时开 2–3 个 Work，
 * 8 给了 2–3 倍余量，同时把最坏内存钉在 ~1MB 以内。
 *
 * 淘汰规则（LRU + 两条保护）：
 * ① 被组件挂载中的分片（pins > 0）不淘汰——正在编辑的东西不能被抽走；
 * ② 有未保存草稿（dirty）的分片不淘汰——SPEC §10 丢失窗口 ≤1s，宁可超额也不丢用户输入；
 * ③ 剩下的按最久未使用淘汰。若全都被保护，则**允许临时超出上限**，
 *    等它们保存或卸载后自然回落。超限是有界的（≤ 打开过的脏作品数），不是泄漏。
 * ④ 淘汰只针对**本次调用前就已存在**的分片；本次刚建的那一片永不淘汰，
 *    否则「全保护」时会牺牲新片来凑上限，与 ②③ 直接矛盾（P1 回归见 test/workStoreEviction.test.ts）。
 */
export const MAX_WORK_SLICES = 8;

export interface WorkSelection {
  start: number;
  end: number;
}

export interface WorkDraft {
  text: string;
  /** autosave 的基线版本（T-16 用）；null = 还没跟服务端对过版本。 */
  baseVersion: number | null;
  dirty: boolean;
}

export interface WorkSliceState {
  /** 分片自证身份：拿到的 state 一定属于传入的 workId。 */
  workId: string;
  draft: WorkDraft;
  caret: number | null;
  selection: WorkSelection | null;
  undoStack: string[];
  redoStack: string[];
  setDraftText: (text: string) => void;
  /** 落库成功后清脏并推进基线版本；不清空 undo 栈（撤销跨保存仍可用）。 */
  markSaved: (baseVersion: number) => void;
  setSelection: (selection: WorkSelection | null) => void;
  undo: () => void;
  redo: () => void;
}

export type WorkSliceStore = StoreApi<WorkSliceState>;

function createWorkSlice(workId: string): WorkSliceStore {
  return createStore<WorkSliceState>()((set, get) => ({
    workId,
    draft: { text: '', baseVersion: null, dirty: false },
    caret: null,
    selection: null,
    undoStack: [],
    redoStack: [],
    setDraftText: (text) =>
      set((s) => {
        if (s.draft.text === text) return s;
        return {
          draft: { ...s.draft, text, dirty: true },
          undoStack: [...s.undoStack, s.draft.text].slice(-UNDO_LIMIT),
          // 新输入让重做失效，这是编辑器语义，不是跨 work 的副作用。
          redoStack: [],
        };
      }),
    markSaved: (baseVersion) => set((s) => ({ draft: { ...s.draft, baseVersion, dirty: false } })),
    setSelection: (selection) =>
      set({ selection, caret: selection == null ? null : selection.end }),
    undo: () => {
      const s = get();
      const prev = s.undoStack.at(-1);
      if (prev == null) return;
      set({
        draft: { ...s.draft, text: prev, dirty: true },
        undoStack: s.undoStack.slice(0, -1),
        redoStack: [...s.redoStack, s.draft.text].slice(-UNDO_LIMIT),
      });
    },
    redo: () => {
      const s = get();
      const next = s.redoStack.at(-1);
      if (next == null) return;
      set({
        draft: { ...s.draft, text: next, dirty: true },
        redoStack: s.redoStack.slice(0, -1),
        undoStack: [...s.undoStack, s.draft.text].slice(-UNDO_LIMIT),
      });
    },
  }));
}

interface Entry {
  store: WorkSliceStore;
  /** 挂载中的组件数；>0 不可淘汰。 */
  pins: number;
  /** 单调递增的使用序号，不用 Date.now：同毫秒内多次访问也能排出先后。 */
  usedAt: number;
}

const registry = new Map<string, Entry>();
let clock = 0;

/**
 * 淘汰到上限为止。`justCreatedId` 是本次调用刚建的那一片，**永远不是候选**。
 *
 * 为什么必须显式排除它：新片此刻 pins===0（pin 在 effect 里才加）且 !dirty，
 * 光看「可淘汰」条件它完全合法；虽然 usedAt 最大排在末尾，但当其余分片全部受保护时，
 * 候选集里就只剩它自己 —— 那就会把正要返回给调用方的实例从表里摘掉，
 * 调用方订阅的是孤儿，effect 里 acquire 又新建另一个实例，用户输入静默丢失。
 * 排除之后，「全保护 ⇒ 允许有界超限」这条不变量才真的成立（见 MAX_WORK_SLICES 注释 ③）。
 */
function evictIfNeeded(justCreatedId: string): void {
  if (registry.size <= MAX_WORK_SLICES) return;
  const victims = [...registry.entries()]
    .filter(([id, e]) => id !== justCreatedId && e.pins === 0 && !e.store.getState().draft.dirty)
    .sort((a, b) => a[1].usedAt - b[1].usedAt);
  for (const [id] of victims) {
    if (registry.size <= MAX_WORK_SLICES) break;
    registry.delete(id);
  }
}

/**
 * get-or-create。纯函数式入口（不依赖 React），路由 loader、mutation 回调、测试都能直接用。
 * 每次调用都算一次「使用」，刷新 LRU 序号。
 *
 * 保证：返回的实例调用结束后仍等于 registry.get(workId) 的实例，紧接着再取还是同一个对象。
 */
export function getWorkSlice(workId: string): WorkSliceStore {
  const existing = registry.get(workId);
  if (existing != null) {
    existing.usedAt = ++clock;
    return existing.store;
  }
  const store = createWorkSlice(workId);
  registry.set(workId, { store, pins: 0, usedAt: ++clock });
  evictIfNeeded(workId);
  return store;
}

/** 挂载期占位：防止正在编辑的分片被 LRU 抽走。与 release 成对使用。 */
export function acquireWorkSlice(workId: string): WorkSliceStore {
  const store = getWorkSlice(workId);
  const entry = registry.get(workId);
  if (entry != null) entry.pins += 1;
  return store;
}

export function releaseWorkSlice(workId: string): void {
  const entry = registry.get(workId);
  if (entry != null) entry.pins = Math.max(0, entry.pins - 1);
}

/** 当前驻留的分片 id（按插入序）。给测试与 dev 排查看，不参与业务判断。 */
export function workSliceIds(): string[] {
  return [...registry.keys()];
}

export function workSliceCount(): number {
  return registry.size;
}

/** 仅测试用：整表清空。业务代码不得调用——「一键重置所有 work」正是 D-05 的形状。 */
export function clearWorkSlices(): void {
  registry.clear();
  clock = 0;
}

/**
 * 组件入口。selector 必须返回原始值或稳定引用（zustand 5 用 useSyncExternalStore，
 * 每次渲染新建对象会触发无限重渲染）。
 *
 * 渲染期 get-or-create 是有意的：分片是缓存不是订阅源，重复调用幂等；
 * pin 放在 effect 里，StrictMode 的 mount→unmount→mount 会 acquire/release/acquire，净计数仍为 1。
 */
export function useWorkStore<T>(workId: string, selector: (state: WorkSliceState) => T): T {
  const store = getWorkSlice(workId);
  useEffect(() => {
    acquireWorkSlice(workId);
    return () => releaseWorkSlice(workId);
  }, [workId]);
  return useStore(store, selector);
}