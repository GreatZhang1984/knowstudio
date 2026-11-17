import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WorkDraftField } from '../src/work/WorkDraftField';
import {
  MAX_WORK_SLICES,
  acquireWorkSlice,
  clearWorkSlices,
  getWorkSlice,
  releaseWorkSlice,
  workSliceCount,
  workSliceIds,
} from '../src/work/store';
import type { WorkSliceStore } from '../src/work/store';

/**
 * P1 回归：LRU 边界上淘汰错了对象。
 *
 * 旧实现先 registry.set(新片) 再 evictIfNeeded()，新片 pins===0 && !dirty，
 * 于是它自己就是合法 victim；当其余分片**全部受保护**（全 pin 或全 dirty）时，
 * 候选集里只剩它一个，循环照删不误 —— 返回给调用方的是一个已从 registry 摘除的孤儿 store。
 *
 * 放大器：useWorkStore 渲染期 getWorkSlice 拿到孤儿并订阅它，
 * effect 里 acquireWorkSlice 又 get-or-create 出**另一个**实例并 pin 住。
 * 于是 UI 照常显示用户敲的字，而 loader / autosave 走 getWorkSlice 读到的是空草稿 —— 静默数据丢失。
 *
 * dirty 片永不淘汰且卸载后仍受保护 ⇒ 脏片单调累积 ⇒ 长会话必然饱和 ⇒ 此后每个新作品都进孤儿。
 * 所以这不是理论边角，是必然到达的状态。
 *
 * 下面 5 组逐条钉住协调者裁定的不变量。分组名 = 不变量编号，方便复核对照。
 */

const STORE_SRC = fileURLToPath(new URL('../src/work/store.ts', import.meta.url));

/** 灌满 registry：n 片全 dirty、未挂载（长会话里逛过 n 个作品各敲了字没保存）。 */
function saturateDirty(prefix: string, n = MAX_WORK_SLICES): WorkSliceStore[] {
  const stores: WorkSliceStore[] = [];
  for (let i = 1; i <= n; i += 1) {
    const s = getWorkSlice(`${prefix}${i}`);
    s.getState().setDraftText(`${prefix}${i} 的未保存草稿`);
    stores.push(s);
  }
  // 前置条件自检：灌不满 / 灌不脏，后面的断言就是假绿。
  expect(workSliceCount(), '前置条件：registry 必须真的灌满').toBe(n);
  expect(stores.every((s) => s.getState().draft.dirty), '前置条件：必须全 dirty').toBe(true);
  return stores;
}

/** 灌满 registry：n 片全 pin（n 个组件挂载中）。 */
function saturatePinned(prefix: string, n = MAX_WORK_SLICES): string[] {
  const ids: string[] = [];
  for (let i = 1; i <= n; i += 1) {
    const id = `${prefix}${i}`;
    acquireWorkSlice(id);
    ids.push(id);
  }
  expect(workSliceCount(), '前置条件：registry 必须真的灌满').toBe(n);
  expect(workSliceIds(), '前置条件：灌进去的必须都还在表里').toEqual(ids);
  return ids;
}

/** 灌满 registry：nPin 片挂载中 + nDirty 片有未保存草稿（两种保护混在一起）。 */
function saturateMixed(prefix: string, nPin: number, nDirty: number): WorkSliceStore[] {
  const stores: WorkSliceStore[] = [];
  for (let i = 1; i <= nPin; i += 1) stores.push(acquireWorkSlice(`${prefix}Pin${i}`));
  for (let i = 1; i <= nDirty; i += 1) {
    const s = getWorkSlice(`${prefix}Dirty${i}`);
    s.getState().setDraftText(`${prefix}Dirty${i} 的未保存草稿`);
    stores.push(s);
  }
  const n = nPin + nDirty;
  expect(workSliceCount(), '前置条件：registry 必须真的灌满').toBe(n);
  // 前置条件自检：每一片都必须至少命中一条保护，否则「全保护」这个前提是假的。
  const unprotected = workSliceIds().filter((id) => {
    const s = getWorkSlice(id);
    return !s.getState().draft.dirty && !id.includes('Pin');
  });
  expect(unprotected, '前置条件：不允许存在无保护的分片').toEqual([]);
  return stores;
}

beforeEach(() => {
  clearWorkSlices();
});

describe('不变量1 · getWorkSlice 返回的实例必须仍是 registry 里的那一个', () => {
  it('8 片全 pin 时开新片：返回后仍在 registry 里，紧接着再取 === 同一对象', () => {
    saturatePinned('p');
    const fresh = getWorkSlice('p9');
    expect(workSliceIds(), '新片不能被摘除').toContain('p9');
    expect(getWorkSlice('p9'), '再取必须是同一个实例，不能是重建的').toBe(fresh);
  });

  it('8 片全 dirty 时开新片：返回后仍在 registry 里，紧接着再取 === 同一对象', () => {
    saturateDirty('d');
    const fresh = getWorkSlice('d9');
    expect(workSliceIds()).toContain('d9');
    expect(getWorkSlice('d9')).toBe(fresh);
  });

  it('饱和态下写进新片的正文，随后 getWorkSlice 读得回来（autosave / loader 视角）', () => {
    saturateDirty('d');
    const fresh = getWorkSlice('d9');
    fresh.getState().setDraftText('用户在第 9 个作品里敲的字');
    // 这一条才是「用户输入有没有丢」的正面判据：换个调用方读同一个 workId。
    expect(getWorkSlice('d9').getState().draft.text).toBe('用户在第 9 个作品里敲的字');
    expect(getWorkSlice('d9').getState().draft.dirty).toBe(true);
  });
});

describe('不变量2 · 淘汰只能淘汰调用前就已存在的分片，永不淘汰本次新建的那一片', () => {
  it('全 pin 饱和：本次调用前后 registry 的差集只允许「新增 p9」，不允许任何删除', () => {
    saturatePinned('p');
    const before = workSliceIds();
    expect(before, '前置条件：registry 必须真的满了且全受保护').toHaveLength(MAX_WORK_SLICES);
    getWorkSlice('p9New');
    const after = workSliceIds();
    const removed = before.filter((id) => !after.includes(id));
    expect(removed, '旧片全受保护，一个都不该被删').toEqual([]);
    expect(after).toContain('p9New');
  });

  it('全 dirty 饱和：同上，旧脏片一个都不许丢', () => {
    const stores = saturateDirty('d');
    const before = workSliceIds();
    getWorkSlice('d9New');
    const after = workSliceIds();
    expect(before.filter((id) => !after.includes(id))).toEqual([]);
    expect(after).toContain('d9New');
    stores.forEach((s, i) => {
      expect(s.getState().draft.text, `旧脏片 d${i + 1} 的正文必须原样在`).toBe(
        `d${i + 1} 的未保存草稿`,
      );
    });
  });

  it('4 pin + 4 dirty 混合饱和：本次调用零删除，新片与 8 片旧片全在', () => {
    const stores = saturateMixed('m', 4, 4);
    const before = workSliceIds();
    expect(before).toHaveLength(MAX_WORK_SLICES);
    const fresh = getWorkSlice('m9New');
    const after = workSliceIds();
    expect(before.filter((id) => !after.includes(id)), '两种保护混合时也不许删任何旧片').toEqual([]);
    expect(after).toContain('m9New');
    expect(getWorkSlice('m9New')).toBe(fresh);
    // 4 片 dirty 的正文必须原样在（pin 片是空草稿，只验引用）。
    stores.slice(4).forEach((s, i) => {
      expect(s.getState().draft.text).toBe(`mDirty${i + 1} 的未保存草稿`);
      expect(getWorkSlice(`mDirty${i + 1}`)).toBe(s);
    });
    stores.slice(0, 4).forEach((s, i) => {
      expect(getWorkSlice(`mPin${i + 1}`), 'pin 片必须还是同一个实例').toBe(s);
    });
  });

  it('饱和后连开 12 个新 Work：零孤儿（脏片单调累积 ⇒ 这是长会话的必然状态，不是边角）', () => {
    saturateDirty('s');
    const orphans: string[] = [];
    for (let i = 9; i <= 20; i += 1) {
      const id = `s${i}`;
      const render = getWorkSlice(id);
      render.getState().setDraftText(`正文 ${i}`);
      const effect = acquireWorkSlice(id);
      const reread = getWorkSlice(id);
      if (render !== effect || reread !== render || reread.getState().draft.text !== `正文 ${i}`) {
        orphans.push(id);
      }
      releaseWorkSlice(id);
    }
    expect(orphans, '这些 workId 的用户输入进了孤儿 store').toEqual([]);
  });
});

describe('不变量3 · 全部受保护时允许有界超限，不得为了凑上限而丢输入', () => {
  it('8 片全 pin → 开第 9 片后 size = 9（超限），而不是牺牲新片凑回 8', () => {
    saturatePinned('p');
    getWorkSlice('p9');
    expect(workSliceCount()).toBe(MAX_WORK_SLICES + 1);
    expect(workSliceIds()).toHaveLength(MAX_WORK_SLICES + 1);
  });

  it('8 片全 dirty → 开第 9 片后 size = 9，且 9 片正文全在', () => {
    saturateDirty('d');
    getWorkSlice('d9').getState().setDraftText('d9 的未保存草稿');
    expect(workSliceCount()).toBe(MAX_WORK_SLICES + 1);
    for (let i = 1; i <= 9; i += 1) {
      expect(getWorkSlice(`d${i}`).getState().draft.text).toBe(`d${i} 的未保存草稿`);
    }
  });

  it('4 pin + 4 dirty 混合饱和 → 开第 9 片后 size = 9，且 9 片一个不少', () => {
    saturateMixed('m', 4, 4);
    getWorkSlice('m9');
    expect(workSliceCount()).toBe(MAX_WORK_SLICES + 1);
    expect(workSliceIds()).toHaveLength(MAX_WORK_SLICES + 1);
    for (let i = 1; i <= 4; i += 1) {
      expect(workSliceIds()).toContain(`mPin${i}`);
      expect(workSliceIds()).toContain(`mDirty${i}`);
      expect(getWorkSlice(`mDirty${i}`).getState().draft.text).toBe(`mDirty${i} 的未保存草稿`);
    }
    expect(workSliceIds()).toContain('m9');
  });

  it('混合饱和的超限同样有界：卸载 pin 片 + 保存 dirty 片后回落到上限', () => {
    const stores = saturateMixed('m', 4, 4);
    getWorkSlice('m9');
    expect(workSliceCount()).toBe(MAX_WORK_SLICES + 1);
    for (let i = 1; i <= 4; i += 1) releaseWorkSlice(`mPin${i}`);
    stores.slice(4).forEach((s) => s.getState().markSaved(1));
    getWorkSlice('m10');
    expect(workSliceCount()).toBe(MAX_WORK_SLICES);
    expect(workSliceIds()).toContain('m10');
  });

  it('超限是有界的：卸载 + 保存之后回落到上限，不是泄漏', () => {
    const pinned = saturatePinned('p');
    getWorkSlice('p9');
    expect(workSliceCount()).toBe(MAX_WORK_SLICES + 1);
    pinned.forEach(releaseWorkSlice);
    // 全卸载后它们变成干净未挂载片，下一次创建触发淘汰即回落。
    getWorkSlice('p10');
    expect(workSliceCount()).toBe(MAX_WORK_SLICES);
    expect(workSliceIds()).toContain('p10');
  });

  it('dirty 片保存后重新可淘汰：超限自然回落，且回落不牺牲新片', () => {
    const dirty = saturateDirty('d');
    getWorkSlice('d9');
    expect(workSliceCount()).toBe(MAX_WORK_SLICES + 1);
    dirty.forEach((s) => s.getState().markSaved(1));
    getWorkSlice('d10');
    expect(workSliceCount()).toBe(MAX_WORK_SLICES);
    expect(workSliceIds()).toContain('d10');
  });
});

describe('不变量4 · 干净且未挂载的场景仍按最久未使用淘汰（别把正确行为改坏）', () => {
  it('8 片干净未挂载 → 开第 9 片淘汰最久未用的 c1，总数仍封顶 8', () => {
    for (let i = 1; i <= MAX_WORK_SLICES; i += 1) getWorkSlice(`c${i}`);
    const fresh = getWorkSlice('c9');
    expect(workSliceIds()).not.toContain('c1');
    expect(workSliceIds()).toContain('c9');
    expect(workSliceCount()).toBe(MAX_WORK_SLICES);
    expect(getWorkSlice('c9')).toBe(fresh);
  });

  it('访问刷新 LRU：刚用过的 c1 留下，最久未用的 c2 走', () => {
    for (let i = 1; i <= MAX_WORK_SLICES; i += 1) getWorkSlice(`c${i}`);
    getWorkSlice('c1');
    getWorkSlice('c9');
    expect(workSliceIds()).toContain('c1');
    expect(workSliceIds()).not.toContain('c2');
  });

  it('混合场景：只淘汰干净未挂载的那片，pin 片与 dirty 片都不动', () => {
    acquireWorkSlice('mPin');
    getWorkSlice('mDirty').getState().setDraftText('没保存');
    for (let i = 1; i <= MAX_WORK_SLICES - 2; i += 1) getWorkSlice(`m${i}`);
    expect(workSliceCount()).toBe(MAX_WORK_SLICES);
    getWorkSlice('mNew');
    expect(workSliceIds()).toContain('mPin');
    expect(workSliceIds()).toContain('mDirty');
    expect(workSliceIds()).toContain('mNew');
    expect(workSliceIds()).not.toContain('m1');
    expect(workSliceCount()).toBe(MAX_WORK_SLICES);
    expect(getWorkSlice('mDirty').getState().draft.text).toBe('没保存');
  });

  it('超限只在「无可淘汰对象」时发生：有一片干净就该淘汰它而不是超限', () => {
    saturateDirty('d', MAX_WORK_SLICES - 1);
    getWorkSlice('dClean'); // 第 8 片，干净未挂载
    getWorkSlice('dNew');
    expect(workSliceCount()).toBe(MAX_WORK_SLICES);
    expect(workSliceIds()).not.toContain('dClean');
    expect(workSliceIds()).toContain('dNew');
  });
});

describe('不变量5 · useWorkStore 渲染期的 store 与 effect 里 pin 住的 store 必须是同一个', () => {
  /**
   * 本仓 vitest 是 node 环境、没装 jsdom（也不准加依赖），effect 跑不起来。
   * 所以这里按 useWorkStore 的真实调用序列建模：渲染期 getWorkSlice → effect 里 acquireWorkSlice。
   * 真实 hook（effect 真的执行）由浏览器实测覆盖，见报告 §11 的 CDP 存证。
   */
  it('全 pin 饱和：render → effect 两次调用拿到同一个 store，pin 计数落在同一片上', () => {
    saturatePinned('p');
    const rendered = getWorkSlice('p9'); // 渲染期
    const pinned = acquireWorkSlice('p9'); // effect
    expect(pinned, 'effect pin 住的必须是渲染期订阅的那一片').toBe(rendered);
    expect(getWorkSlice('p9')).toBe(rendered);
    // pin 真的生效：再开新片也不能把 p9 抽走。
    getWorkSlice('p10');
    expect(workSliceIds()).toContain('p9');
    expect(getWorkSlice('p9')).toBe(rendered);
    releaseWorkSlice('p9');
  });

  it('全 dirty 饱和：render 期敲的字，effect pin 之后 autosave 读得到（不是空文本）', () => {
    saturateDirty('d');
    const rendered = getWorkSlice('d9');
    rendered.getState().setDraftText('用户在第 9 个作品里敲的字');
    const pinned = acquireWorkSlice('d9');
    expect(pinned).toBe(rendered);
    // autosave / loader 只会走 getWorkSlice，读到的必须就是用户敲的那串。
    expect(getWorkSlice('d9').getState().draft.text).toBe('用户在第 9 个作品里敲的字');
    releaseWorkSlice('d9');
  });

  it('饱和态下真实组件渲染：WorkDraftField 绑的分片仍在 registry 里，不是孤儿', () => {
    saturateDirty('d');
    const html = renderToStaticMarkup(h(WorkDraftField, { workId: 'd9' }));
    expect(html).toContain('data-work-id="d9"');
    expect(workSliceIds(), '组件渲染用的分片必须还在表里').toContain('d9');
    const afterRender = getWorkSlice('d9');
    expect(afterRender.getState().workId).toBe('d9');
    // 组件之后若有人写入，再读还是同一片。
    afterRender.getState().setDraftText('组件之后写入');
    expect(getWorkSlice('d9').getState().draft.text).toBe('组件之后写入');
  });

  it('4 pin + 4 dirty 混合饱和：render → effect 同一实例，且写入对 getWorkSlice 可见', () => {
    saturateMixed('m', 4, 4);
    const rendered = getWorkSlice('m9');
    rendered.getState().setDraftText('混合饱和下第 9 个作品的输入');
    const pinned = acquireWorkSlice('m9');
    expect(pinned, 'effect pin 住的必须是渲染期订阅的那一片').toBe(rendered);
    expect(getWorkSlice('m9').getState().draft.text).toBe('混合饱和下第 9 个作品的输入');
    releaseWorkSlice('m9');
  });

  it('组件级同一实例：饱和态下组件渲染用的分片 === 随后 getWorkSlice 拿到的分片（三种饱和各验一遍）', () => {
    const scenarios: Array<[string, () => void]> = [
      ['8 全 pin', () => void saturatePinned('p')],
      ['8 全 dirty', () => void saturateDirty('d')],
      ['4 pin + 4 dirty', () => void saturateMixed('m', 4, 4)],
    ];
    for (const [label, saturate] of scenarios) {
      clearWorkSlices();
      saturate();
      const html = renderToStaticMarkup(h(WorkDraftField, { workId: 'fresh' }));
      expect(html, label).toContain('data-work-id="fresh"');
      expect(workSliceIds(), `${label}：组件用的分片必须还在表里`).toContain('fresh');
      const viaRegistry = getWorkSlice('fresh');
      // 组件写入 → 另一个调用方读回：同一片才读得到，孤儿会读成空串。
      viaRegistry.getState().setDraftText(`${label} 下组件写入的正文`);
      expect(getWorkSlice('fresh'), label).toBe(viaRegistry);
      expect(getWorkSlice('fresh').getState().draft.text, label).toBe(`${label} 下组件写入的正文`);
      expect(workSliceCount(), `${label}：允许有界超限`).toBe(MAX_WORK_SLICES + 1);
    }
  });

  it('源码形状：渲染期 getWorkSlice + effect 内 acquire/release，且都是同一个 workId', () => {
    const src = readFileSync(STORE_SRC, 'utf8');
    const hook = src.slice(src.indexOf('export function useWorkStore'));
    expect(hook, '扫描面非空（切错位置会静默全绿）').toContain('useStore(store, selector)');
    expect(hook).toMatch(/const store = getWorkSlice\(workId\)/);
    expect(hook).toMatch(/useEffect\(\(\) => \{\s*acquireWorkSlice\(workId\);/);
    expect(hook).toMatch(/return \(\) => releaseWorkSlice\(workId\);/);
    expect(hook).toMatch(/\}, \[workId\]\);/);
  });
});

describe('回归护栏 · 淘汰候选集的构造方式本身', () => {
  it('evictIfNeeded 的候选集必须排除本次新建的 workId（不是靠 usedAt 排序碰巧躲过）', () => {
    const src = readFileSync(STORE_SRC, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    const fn = src.slice(src.indexOf('function evictIfNeeded'), src.indexOf('export function getWorkSlice'));
    expect(fn, '扫描面非空').toContain('registry.delete');
    // 候选集过滤里必须显式带上「不是本次新建的那一片」这一项。
    expect(fn).toMatch(/function evictIfNeeded\(\s*\w+\s*:\s*string\s*\)/);
    expect(fn).toMatch(/id\s*!==\s*\w+/);
    // 创建路径必须把新片 id 传进去。
    expect(src).toMatch(/evictIfNeeded\(\s*workId\s*\)/);
  });
});