import { beforeEach, describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WorkDraftField } from '../src/work/WorkDraftField';
import {
  MAX_WORK_SLICES,
  UNDO_LIMIT,
  acquireWorkSlice,
  clearWorkSlices,
  getWorkSlice,
  releaseWorkSlice,
  workSliceCount,
  workSliceIds,
} from '../src/work/store';
import type { WorkSliceState, WorkSliceStore } from '../src/work/store';

/** 只取数据字段：state 里还有 action 函数，整体 toEqual 没有意义。 */
function dataOf(store: WorkSliceStore) {
  const s = store.getState();
  return {
    workId: s.workId,
    draft: s.draft,
    caret: s.caret,
    selection: s.selection,
    undoStack: s.undoStack,
    redoStack: s.redoStack,
  } satisfies Omit<
    WorkSliceState,
    'setDraftText' | 'markSaved' | 'setSelection' | 'undo' | 'redo'
  >;
}

beforeEach(() => {
  clearWorkSlices();
});

describe('AC-H2 · 两个 workId 的分片状态互不污染', () => {
  it('建 A → 建 B → 改 B → 回 A：A 一个字节都没变', () => {
    const a = getWorkSlice('wA');
    a.getState().setDraftText('A 的草稿');
    a.getState().setSelection({ start: 2, end: 5 });
    const snapshot = dataOf(a);

    const b = getWorkSlice('wB');
    b.getState().setDraftText('B 的草稿');
    b.getState().setDraftText('B 又改了一次');
    b.getState().setSelection({ start: 0, end: 1 });
    b.getState().undo();

    const backToA = getWorkSlice('wA');
    expect(backToA, '回到 A 必须拿到同一个实例，而不是重建').toBe(a);
    expect(dataOf(backToA)).toEqual(snapshot);
    expect(backToA.getState().draft.text).toBe('A 的草稿');
    expect(backToA.getState().caret).toBe(5);
    expect(b.getState().draft.text).toBe('B 的草稿');
  });

  it('新建第三个 Work 不重置旧 Work（D-05 根因）', () => {
    const a = getWorkSlice('wA');
    a.getState().setDraftText('A 的草稿');
    const b = getWorkSlice('wB');
    b.getState().setDraftText('B 的草稿');
    const beforeA = dataOf(a);
    const beforeB = dataOf(b);

    const fresh = getWorkSlice('wNew');
    expect(fresh.getState().draft).toEqual({ text: '', baseVersion: null, dirty: false });
    expect(fresh.getState().undoStack).toEqual([]);
    expect(dataOf(a)).toEqual(beforeA);
    expect(dataOf(b)).toEqual(beforeB);
  });

  it('分片自证身份：state.workId 恒等于取它时传的 id', () => {
    for (const id of ['w1', 'w2', 'w3']) {
      expect(getWorkSlice(id).getState().workId).toBe(id);
    }
  });

  it('两个 Work 的同名动作落到各自的实例上', () => {
    const a = getWorkSlice('wA');
    const b = getWorkSlice('wB');
    a.getState().setDraftText('a1');
    a.getState().setDraftText('a2');
    b.getState().setDraftText('b1');
    a.getState().undo();
    expect(a.getState().draft.text).toBe('a1');
    expect(a.getState().redoStack).toEqual(['a2']);
    expect(b.getState().draft.text).toBe('b1');
    expect(b.getState().undoStack).toEqual(['']);
    expect(b.getState().redoStack).toEqual([]);
  });
});

describe('瞬时态语义', () => {
  it('undo 栈封顶 20 步（架构 §11.3 ≥20 步 + 内存有界）', () => {
    const s = getWorkSlice('wA');
    for (let i = 0; i < UNDO_LIMIT + 15; i += 1) s.getState().setDraftText(`第 ${i} 版`);
    expect(s.getState().undoStack).toHaveLength(UNDO_LIMIT);
    for (let i = 0; i < UNDO_LIMIT + 15; i += 1) s.getState().undo();
    expect(s.getState().undoStack).toHaveLength(0);
    expect(s.getState().redoStack).toHaveLength(UNDO_LIMIT);
  });

  it('写入才置脏；markSaved 清脏并推进基线版本', () => {
    const s = getWorkSlice('wA');
    expect(s.getState().draft.dirty).toBe(false);
    s.getState().setDraftText('x');
    expect(s.getState().draft.dirty).toBe(true);
    s.getState().markSaved(7);
    expect(s.getState().draft).toEqual({ text: 'x', baseVersion: 7, dirty: false });
  });

  it('相同文本重复写入不产生 undo 噪声', () => {
    const s = getWorkSlice('wA');
    s.getState().setDraftText('x');
    s.getState().setDraftText('x');
    expect(s.getState().undoStack).toEqual(['']);
  });
});

describe('内存上限与淘汰策略', () => {
  it('干净分片超过上限时按 LRU 淘汰，总数封顶', () => {
    for (let i = 0; i < MAX_WORK_SLICES; i += 1) getWorkSlice(`w${i}`);
    expect(workSliceCount()).toBe(MAX_WORK_SLICES);
    getWorkSlice('wNew');
    expect(workSliceCount()).toBe(MAX_WORK_SLICES);
    expect(workSliceIds()).not.toContain('w0');
    expect(workSliceIds()).toContain('wNew');
  });

  it('访问会刷新 LRU：最久未用的先走，不是最早建的先走', () => {
    for (let i = 0; i < MAX_WORK_SLICES; i += 1) getWorkSlice(`w${i}`);
    getWorkSlice('w0'); // w0 刚被用过，w1 变成最久未用
    getWorkSlice('wNew');
    expect(workSliceIds()).toContain('w0');
    expect(workSliceIds()).not.toContain('w1');
  });

  it('有未保存草稿的分片绝不淘汰（宁可临时超限，也不丢用户输入）', () => {
    const dirty = getWorkSlice('wDirty');
    dirty.getState().setDraftText('还没保存');
    for (let i = 0; i < MAX_WORK_SLICES + 4; i += 1) getWorkSlice(`w${i}`);
    expect(workSliceIds()).toContain('wDirty');
    expect(getWorkSlice('wDirty').getState().draft.text).toBe('还没保存');

    // 保存之后重新变成可淘汰对象，超限自然回落。
    dirty.getState().markSaved(1);
    for (let i = 100; i < 100 + MAX_WORK_SLICES + 4; i += 1) getWorkSlice(`w${i}`);
    expect(workSliceIds()).not.toContain('wDirty');
    expect(workSliceCount()).toBe(MAX_WORK_SLICES);
  });

  it('挂载中（pin）的分片不淘汰，卸载后才可淘汰', () => {
    acquireWorkSlice('wMounted');
    for (let i = 0; i < MAX_WORK_SLICES + 4; i += 1) getWorkSlice(`w${i}`);
    expect(workSliceIds()).toContain('wMounted');

    releaseWorkSlice('wMounted');
    for (let i = 100; i < 100 + MAX_WORK_SLICES + 4; i += 1) getWorkSlice(`w${i}`);
    expect(workSliceIds()).not.toContain('wMounted');
  });

  it('release 不会把计数打成负数', () => {
    acquireWorkSlice('wA');
    releaseWorkSlice('wA');
    releaseWorkSlice('wA');
    for (let i = 0; i < MAX_WORK_SLICES + 2; i += 1) getWorkSlice(`w${i}`);
    expect(workSliceIds()).not.toContain('wA');
  });
});

describe('容器接线：同一个组件换 workId 就绑到另一片', () => {
  /**
   * 注意：zustand 5 的 useStore 在 SSR 下走 getServerSnapshot（= 初始状态），
   * 所以这里只能断言「绑到了哪一片」，断言不了草稿正文。
   * 正文随 workId 各自独立由浏览器实测（真实客户端渲染）覆盖。
   */
  it('WorkDraftField 按 workId 绑定分片，换 id 换片', () => {
    getWorkSlice('w1').getState().setDraftText('一号作品的草稿');
    getWorkSlice('w2').getState().setDraftText('二号作品的草稿');

    const one = renderToStaticMarkup(h(WorkDraftField, { workId: 'w1' }));
    const two = renderToStaticMarkup(h(WorkDraftField, { workId: 'w2' }));

    expect(one).toContain('data-work-id="w1"');
    expect(one).toContain('作品 w1 的本地草稿');
    expect(two).toContain('data-work-id="w2"');
    expect(two).toContain('作品 w2 的本地草稿');
    expect(one).not.toBe(two);
    // 组件读到的 selector 结果确实来自各自的分片。
    expect(getWorkSlice('w1').getState().draft.text).toBe('一号作品的草稿');
    expect(getWorkSlice('w2').getState().draft.text).toBe('二号作品的草稿');
  });

  it('没写过的 Work 是空白草稿，不会捡到别人的内容', () => {
    getWorkSlice('w1').getState().setDraftText('一号作品的草稿');
    const fresh = renderToStaticMarkup(h(WorkDraftField, { workId: 'wFresh' }));
    expect(fresh).toContain('data-work-id="wFresh"');
    expect(getWorkSlice('wFresh').getState().draft).toEqual({
      text: '',
      baseVersion: null,
      dirty: false,
    });
    expect(getWorkSlice('w1').getState().draft.text).toBe('一号作品的草稿');
  });
});