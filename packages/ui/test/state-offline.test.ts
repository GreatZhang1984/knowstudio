import { describe, expect, it } from 'vitest';
import { createOfflineController, offlineCopy } from '../src/state/offline';
import type { OfflineState } from '../src/state/offline';
import type { ConnectivityPort, DraftEnvelope, DraftPort } from '../src/state/ports';

/**
 * 验收④：离线横幅的暂存 port 被正确调用。
 *
 * 这里测的是横幅背后的状态机（与 React 解耦），因此能在 node 环境确定性驱动：
 * 注入假的 ConnectivityPort / DraftPort，断言**调用序列**与**载荷**，
 * 而不是只看渲染出来的字。存储实现本身不在 T-08 范围（T-16）。
 */

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function fakeConnectivity(initial: boolean) {
  let online = initial;
  const listeners = new Set<(online: boolean) => void>();
  const port: ConnectivityPort = {
    isOnline: () => online,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    port,
    set: (next: boolean) => {
      online = next;
      for (const listener of [...listeners]) listener(next);
    },
    listenerCount: () => listeners.size,
  };
}

interface FakePort {
  port: DraftPort;
  calls: string[];
  store: Map<string, DraftEnvelope>;
  failSave: boolean;
  failClear: boolean;
  failLoad: boolean;
}

function fakeDraftPort(): FakePort {
  const store = new Map<string, DraftEnvelope>();
  const calls: string[] = [];
  const fake: FakePort = {
    calls,
    store,
    failSave: false,
    failClear: false,
    failLoad: false,
    port: {
      save: async (draft) => {
        calls.push(`save:${draft.key}`);
        if (fake.failSave) throw new Error('IndexedDB 不可用');
        store.set(draft.key, draft);
      },
      load: async (key) => {
        calls.push(`load:${key}`);
        if (fake.failLoad) throw new Error('IndexedDB 读失败');
        return store.get(key) ?? null;
      },
      clear: async (key) => {
        calls.push(`clear:${key}`);
        if (fake.failClear) throw new Error('IndexedDB 删失败');
        store.delete(key);
      },
    },
  };
  return fake;
}

const KEY = 'work:w1:script';
const CLOCK = (): string => '2026-11-13T02:00:00Z';
const draftInput = () => ({ payload: { text: '我断网时写的一段' }, baseVersion: 6 });

describe('离线横幅：断网时调用 DraftPort.save', () => {
  it('初始在线：不碰暂存端口', async () => {
    const net = fakeConnectivity(true);
    const draft = fakeDraftPort();
    const c = createOfflineController({
      connectivity: net.port,
      draftPort: draft.port,
      draftKey: KEY,
      collectDraft: draftInput,
      now: CLOCK,
    });
    c.start();
    await flush();
    expect(c.getState().phase).toBe('online');
    expect(draft.calls).toEqual([]);
    c.stop();
  });

  it('初始就离线：start 时立刻暂存，信封带 key/savedAt/payload/baseVersion', async () => {
    const net = fakeConnectivity(false);
    const draft = fakeDraftPort();
    const c = createOfflineController({
      connectivity: net.port,
      draftPort: draft.port,
      draftKey: KEY,
      collectDraft: draftInput,
      now: CLOCK,
    });
    c.start();
    await flush();
    expect(draft.calls).toEqual([`save:${KEY}`]);
    expect(draft.store.get(KEY)).toEqual({
      key: KEY,
      savedAt: CLOCK(),
      payload: { text: '我断网时写的一段' },
      baseVersion: 6,
    });
    expect(c.getState()).toMatchObject({ phase: 'offline', stashed: true, pending: true });
    c.stop();
  });

  it('在线 → 离线：订阅回调触发暂存', async () => {
    const net = fakeConnectivity(true);
    const draft = fakeDraftPort();
    const c = createOfflineController({
      connectivity: net.port,
      draftPort: draft.port,
      draftKey: KEY,
      collectDraft: draftInput,
      now: CLOCK,
    });
    c.start();
    net.set(false);
    await flush();
    expect(draft.calls).toEqual([`save:${KEY}`]);
    expect(c.getState().phase).toBe('offline');
    c.stop();
  });

  it('没有 baseVersion 时信封里不出现该键（不写 undefined 进去）', async () => {
    const net = fakeConnectivity(false);
    const draft = fakeDraftPort();
    const c = createOfflineController({
      connectivity: net.port,
      draftPort: draft.port,
      draftKey: KEY,
      collectDraft: () => ({ payload: 'x' }),
      now: CLOCK,
    });
    c.start();
    await flush();
    expect(Object.keys(draft.store.get(KEY) ?? {}).sort()).toEqual(['key', 'payload', 'savedAt']);
    c.stop();
  });

  it('collectDraft 返回 null：没有可暂存内容，不调用 save', async () => {
    const net = fakeConnectivity(false);
    const draft = fakeDraftPort();
    const c = createOfflineController({
      connectivity: net.port,
      draftPort: draft.port,
      draftKey: KEY,
      collectDraft: () => null,
      now: CLOCK,
    });
    c.start();
    await flush();
    expect(draft.calls).toEqual([]);
    expect(c.getState()).toMatchObject({ stashed: false, stashFailed: false });
    expect(offlineCopy(c.getState(), true).text).toContain('没有需要暂存的改动');
    c.stop();
  });

  it('没接 draftPort：绝不声称已暂存，也不调用任何存储', async () => {
    const net = fakeConnectivity(false);
    const c = createOfflineController({ connectivity: net.port, now: CLOCK });
    c.start();
    await flush();
    const copy = offlineCopy(c.getState(), false);
    expect(copy.text).not.toContain('已暂存');
    expect(copy.text).toContain('无法保存到服务器');
    c.stop();
  });

  it('端口在但缺 draftKey：不写入（避免把不同屏的草稿混到一个 key）', async () => {
    const net = fakeConnectivity(false);
    const draft = fakeDraftPort();
    const c = createOfflineController({
      connectivity: net.port,
      draftPort: draft.port,
      collectDraft: draftInput,
      now: CLOCK,
    });
    c.start();
    await flush();
    expect(draft.calls).toEqual([]);
    c.stop();
  });

  it('save 失败：如实报告暂存失败（danger + alert），retry 可再暂存', async () => {
    const net = fakeConnectivity(false);
    const draft = fakeDraftPort();
    draft.failSave = true;
    const c = createOfflineController({
      connectivity: net.port,
      draftPort: draft.port,
      draftKey: KEY,
      collectDraft: draftInput,
      now: CLOCK,
    });
    c.start();
    await flush();
    expect(c.getState()).toMatchObject({ stashed: false, stashFailed: true, pending: false });
    const copy = offlineCopy(c.getState(), true);
    expect(copy.tone).toBe('danger');
    expect(copy.role).toBe('alert');
    expect(copy.text).toContain('本地暂存也失败了');

    draft.failSave = false;
    c.retry();
    await flush();
    expect(draft.calls).toEqual([`save:${KEY}`, `save:${KEY}`]);
    expect(c.getState()).toMatchObject({ stashed: true, stashFailed: false });
    c.stop();
  });
});

describe('离线横幅：恢复联网后 load → sync → clear', () => {
  it('完整链路：把暂存交给 sync，成功后才清副本', async () => {
    const net = fakeConnectivity(false);
    const draft = fakeDraftPort();
    const synced: (DraftEnvelope | null)[] = [];
    const c = createOfflineController({
      connectivity: net.port,
      draftPort: draft.port,
      draftKey: KEY,
      collectDraft: draftInput,
      sync: async (envelope) => {
        synced.push(envelope);
      },
      now: CLOCK,
    });
    c.start();
    await flush();
    net.set(true);
    await flush();
    expect(draft.calls).toEqual([`save:${KEY}`, `load:${KEY}`, `clear:${KEY}`]);
    expect(synced).toHaveLength(1);
    expect(synced[0]).toEqual({
      key: KEY,
      savedAt: CLOCK(),
      payload: { text: '我断网时写的一段' },
      baseVersion: 6,
    });
    expect(c.getState()).toMatchObject({
      phase: 'synced',
      online: true,
      pending: false,
      stashed: false,
    });
    expect(draft.store.size).toBe(0);
    c.stop();
  });

  it('本机没有暂存时 sync 收到 null（屏可据此只做重新拉取）', async () => {
    const net = fakeConnectivity(true);
    const draft = fakeDraftPort();
    const synced: (DraftEnvelope | null)[] = [];
    const c = createOfflineController({
      connectivity: net.port,
      draftPort: draft.port,
      draftKey: KEY,
      collectDraft: () => null,
      sync: async (envelope) => {
        synced.push(envelope);
      },
      now: CLOCK,
    });
    c.start();
    net.set(false);
    await flush();
    net.set(true);
    await flush();
    expect(synced).toEqual([null]);
    expect(draft.calls).toEqual([`load:${KEY}`]);
    expect(c.getState().phase).toBe('synced');
    c.stop();
  });

  it('sync 失败：不清副本、进入 sync-failed、retry 再同步一次', async () => {
    const net = fakeConnectivity(false);
    const draft = fakeDraftPort();
    let fail = true;
    let attempts = 0;
    const c = createOfflineController({
      connectivity: net.port,
      draftPort: draft.port,
      draftKey: KEY,
      collectDraft: draftInput,
      sync: async () => {
        attempts += 1;
        if (fail) throw new Error('PATCH 失败');
      },
      now: CLOCK,
    });
    c.start();
    await flush();
    net.set(true);
    await flush();
    expect(c.getState()).toMatchObject({ phase: 'sync-failed', syncAttempt: 1 });
    expect(draft.calls).toEqual([`save:${KEY}`, `load:${KEY}`]);
    expect(draft.store.has(KEY)).toBe(true);
    expect(offlineCopy(c.getState(), true).role).toBe('alert');

    fail = false;
    c.retry();
    await flush();
    expect(attempts).toBe(2);
    expect(draft.calls).toEqual([`save:${KEY}`, `load:${KEY}`, `load:${KEY}`, `clear:${KEY}`]);
    expect(c.getState()).toMatchObject({ phase: 'synced', syncAttempt: 1, pending: false });
    c.stop();
  });

  it('load 失败也算同步失败：不静默丢掉本机内容', async () => {
    const net = fakeConnectivity(false);
    const draft = fakeDraftPort();
    const c = createOfflineController({
      connectivity: net.port,
      draftPort: draft.port,
      draftKey: KEY,
      collectDraft: draftInput,
      sync: async () => {},
      now: CLOCK,
    });
    c.start();
    await flush();
    draft.failLoad = true;
    net.set(true);
    await flush();
    expect(c.getState().phase).toBe('sync-failed');
    expect(draft.store.has(KEY)).toBe(true);
    c.stop();
  });

  it('clear 失败：同步算成功但如实留下 pending，副本仍在', async () => {
    const net = fakeConnectivity(false);
    const draft = fakeDraftPort();
    const c = createOfflineController({
      connectivity: net.port,
      draftPort: draft.port,
      draftKey: KEY,
      collectDraft: draftInput,
      sync: async () => {},
      now: CLOCK,
    });
    c.start();
    await flush();
    draft.failClear = true;
    net.set(true);
    await flush();
    expect(c.getState()).toMatchObject({ phase: 'synced', pending: true });
    expect(draft.store.has(KEY)).toBe(true);
    expect(offlineCopy(c.getState(), true).text).toContain('本机副本没清掉');
    c.stop();
  });

  it('同步进行中再次断网：飞行中的旧结果作废，不会谎报已同步', async () => {
    const net = fakeConnectivity(false);
    const draft = fakeDraftPort();
    let release: () => void = () => {};
    const c = createOfflineController({
      connectivity: net.port,
      draftPort: draft.port,
      draftKey: KEY,
      collectDraft: draftInput,
      sync: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      now: CLOCK,
    });
    c.start();
    await flush();
    net.set(true);
    await flush();
    expect(c.getState().phase).toBe('syncing');
    net.set(false);
    await flush();
    release();
    await flush();
    expect(c.getState().phase).toBe('offline');
    expect(c.getState().online).toBe(false);
    // 断网后重新暂存了一次，且同步未完成所以没有 clear。
    expect(draft.calls).toEqual([`save:${KEY}`, `load:${KEY}`, `save:${KEY}`]);
    c.stop();
  });

  it('两轮断网/恢复：调用序列逐次正确', async () => {
    const net = fakeConnectivity(true);
    const draft = fakeDraftPort();
    const c = createOfflineController({
      connectivity: net.port,
      draftPort: draft.port,
      draftKey: KEY,
      collectDraft: draftInput,
      sync: async () => {},
      now: CLOCK,
    });
    c.start();
    net.set(false);
    await flush();
    net.set(true);
    await flush();
    c.dismiss();
    net.set(false);
    await flush();
    net.set(true);
    await flush();
    expect(draft.calls).toEqual([
      `save:${KEY}`,
      `load:${KEY}`,
      `clear:${KEY}`,
      `save:${KEY}`,
      `load:${KEY}`,
      `clear:${KEY}`,
    ]);
    expect(c.getState().phase).toBe('synced');
    c.stop();
  });
});

describe('离线横幅：订阅生命周期与状态快照', () => {
  it('状态变化才通知，且 getState 快照在未变化时保持同一引用', async () => {
    const net = fakeConnectivity(true);
    const c = createOfflineController({ connectivity: net.port, now: CLOCK });
    let notified = 0;
    const unsubscribe = c.subscribe(() => {
      notified += 1;
    });
    c.start();
    const first = c.getState();
    net.set(true); // 重复事件，不应产生新状态
    await flush();
    expect(c.getState()).toBe(first);
    expect(notified).toBe(0);
    net.set(false);
    await flush();
    expect(c.getState()).not.toBe(first);
    expect(notified).toBeGreaterThan(0);
    unsubscribe();
    const before = notified;
    net.set(true);
    await flush();
    expect(notified).toBe(before);
    c.stop();
  });

  it('stop 后解除联网订阅，后续网络事件不再改状态', async () => {
    const net = fakeConnectivity(true);
    const c = createOfflineController({ connectivity: net.port, now: CLOCK });
    c.start();
    expect(net.listenerCount()).toBe(1);
    c.stop();
    expect(net.listenerCount()).toBe(0);
    net.set(false);
    await flush();
    expect(c.getState().phase).toBe('online');
  });

  it('重复 start 不重复订阅', () => {
    const net = fakeConnectivity(true);
    const c = createOfflineController({ connectivity: net.port, now: CLOCK });
    c.start();
    c.start();
    expect(net.listenerCount()).toBe(1);
    c.stop();
  });

  it('start 时补读一次联网状态（构造与挂载之间断网也能跟上）', async () => {
    const net = fakeConnectivity(true);
    const draft = fakeDraftPort();
    const c = createOfflineController({
      connectivity: net.port,
      draftPort: draft.port,
      draftKey: KEY,
      collectDraft: draftInput,
      now: CLOCK,
    });
    net.set(false); // 尚未 start，没有订阅者
    c.start();
    await flush();
    expect(c.getState().phase).toBe('offline');
    expect(draft.calls).toEqual([`save:${KEY}`]);
    c.stop();
  });

  it('dismiss 只在 synced 生效：sync-failed 不许被关掉', async () => {
    const net = fakeConnectivity(false);
    const draft = fakeDraftPort();
    const c = createOfflineController({
      connectivity: net.port,
      draftPort: draft.port,
      draftKey: KEY,
      collectDraft: draftInput,
      sync: async () => {
        throw new Error('still failing');
      },
      now: CLOCK,
    });
    c.start();
    await flush();
    net.set(true);
    await flush();
    c.dismiss();
    expect(c.getState().phase).toBe('sync-failed');
    c.stop();
  });

  it('retry 在 online 相位是空操作（不无谓打服务端）', async () => {
    const net = fakeConnectivity(true);
    const draft = fakeDraftPort();
    let calls = 0;
    const c = createOfflineController({
      connectivity: net.port,
      draftPort: draft.port,
      draftKey: KEY,
      sync: async () => {
        calls += 1;
      },
      now: CLOCK,
    });
    c.start();
    c.retry();
    await flush();
    expect(calls).toBe(0);
    expect(draft.calls).toEqual([]);
    c.stop();
  });
});

describe('offlineCopy：五个相位的文案与诚实性', () => {
  const base: OfflineState = {
    online: true,
    phase: 'online',
    stashed: false,
    stashing: false,
    stashFailed: false,
    pending: false,
    syncAttempt: 0,
  };

  it('online 相位文案为空（横幅不渲染）', () => {
    expect(offlineCopy(base, true).text).toBe('');
  });

  it('offline + 已暂存：明说已暂存且会自动同步', () => {
    const copy = offlineCopy({ ...base, online: false, phase: 'offline', stashed: true }, true);
    expect(copy.text).toContain('已暂存在本机');
    expect(copy.tone).toBe('warning');
    expect(copy.role).toBe('status');
  });

  it('offline + 未接端口：不得出现「已暂存」字样', () => {
    const copy = offlineCopy({ ...base, online: false, phase: 'offline' }, false);
    expect(copy.text).not.toContain('已暂存');
  });

  it('syncing / sync-failed / synced 三个相位的色调与 role', () => {
    expect(offlineCopy({ ...base, phase: 'syncing' }, true)).toMatchObject({
      tone: 'info',
      role: 'status',
    });
    expect(offlineCopy({ ...base, phase: 'sync-failed' }, true)).toMatchObject({
      tone: 'danger',
      role: 'alert',
    });
    expect(offlineCopy({ ...base, phase: 'synced' }, true)).toMatchObject({
      tone: 'success',
      role: 'status',
    });
  });

  it('synced 但未接端口：只说网络已恢复，不谎报同步了本地改动', () => {
    expect(offlineCopy({ ...base, phase: 'synced' }, false).text).toBe('网络已恢复。');
  });

  it('暂存失败的文案优先级高于「已暂存」（两者同时为真时以失败为准）', () => {
    const copy = offlineCopy(
      { ...base, online: false, phase: 'offline', stashed: true, stashFailed: true },
      true,
    );
    expect(copy.tone).toBe('danger');
    expect(copy.text).toContain('本地暂存也失败了');
  });

  it('stashing 只影响 offline 相位：syncing / synced 不读它', () => {
    expect(offlineCopy({ ...base, phase: 'syncing', stashing: true }, true).text).toContain(
      '正在同步本地改动',
    );
    expect(offlineCopy({ ...base, phase: 'synced', stashing: true }, true).text).toContain(
      '本地改动已同步',
    );
  });
});

/**
 * P1 竞态回归：save 仍在飞行中就恢复联网。
 * 旧实现里 runSync 不等 stash 落盘就 load → 读到 null → sync(null)，
 * 随后 save 落盘但状态更新被代际号丢弃 → 本机留下无人追踪的副本而 pending:false。
 * 这里用「手动开闸」的 DraftPort 精确控制时序，不用假时钟、不用 sleep。
 */
function gatedDraftPort() {
  const store = new Map<string, DraftEnvelope>();
  const calls: string[] = [];
  const gates: (() => void)[] = [];
  const fake = {
    calls,
    store,
    failClear: false,
    port: {
      save: async (env: DraftEnvelope) => {
        calls.push(`save:${env.key}`);
        await new Promise<void>((resolve) => gates.push(resolve));
        store.set(env.key, env);
        calls.push(`saved:${env.key}`);
      },
      load: async (key: string) => {
        calls.push(`load:${key}`);
        return store.get(key) ?? null;
      },
      clear: async (key: string) => {
        calls.push(`clear:${key}`);
        if (fake.failClear) throw new Error('IndexedDB 删失败');
        store.delete(key);
      },
    } satisfies DraftPort,
    releaseNext: () => {
      gates.shift()?.();
    },
    pendingSaves: () => gates.length,
  };
  return fake;
}

describe('P1 竞态：暂存写入飞行中恢复联网', () => {
  it('不变量1+2：save 未落盘就恢复联网，sync 仍拿到草稿；synced+pending:false 时存储必须为空', async () => {
    const net = fakeConnectivity(true);
    const draft = gatedDraftPort();
    const synced: (DraftEnvelope | null)[] = [];
    const c = createOfflineController({
      connectivity: net.port,
      draftPort: draft.port,
      draftKey: KEY,
      collectDraft: draftInput,
      sync: async (envelope) => {
        synced.push(envelope);
      },
      now: CLOCK,
    });
    c.start();
    net.set(false);
    await flush();
    expect(draft.calls).toEqual([`save:${KEY}`]);
    expect(draft.pendingSaves()).toBe(1);
    expect(c.getState().stashing).toBe(true);

    net.set(true); // save 还在飞行中
    await flush();
    expect(c.getState().phase).toBe('syncing');
    // 关键：load 必须等 save 落盘之后才发生
    expect(draft.calls).toEqual([`save:${KEY}`]);

    draft.releaseNext();
    await flush();
    expect(draft.calls).toEqual([`save:${KEY}`, `saved:${KEY}`, `load:${KEY}`, `clear:${KEY}`]);
    expect(synced).toHaveLength(1);
    expect(synced[0]?.payload).toEqual({ text: '我断网时写的一段' });
    expect(c.getState()).toMatchObject({
      phase: 'synced',
      pending: false,
      stashed: false,
      stashing: false,
    });
    expect(draft.store.size).toBe(0);
    c.stop();
  });

  it('不变量3：竞态下 clear 失败 → pending:true 且文案如实告知副本没清掉', async () => {
    const net = fakeConnectivity(true);
    const draft = gatedDraftPort();
    draft.failClear = true;
    const c = createOfflineController({
      connectivity: net.port,
      draftPort: draft.port,
      draftKey: KEY,
      collectDraft: draftInput,
      sync: async () => {},
      now: CLOCK,
    });
    c.start();
    net.set(false);
    await flush();
    net.set(true);
    await flush();
    draft.releaseNext();
    await flush();
    expect(c.getState()).toMatchObject({ phase: 'synced', pending: true });
    expect(draft.store.has(KEY)).toBe(true);
    expect(offlineCopy(c.getState(), true).text).toContain('本机副本没清掉');
    c.stop();
  });

  it('不变量4：竞态下 sync 失败绝不清副本；retry 后 sync 拿到的是那份草稿', async () => {
    const net = fakeConnectivity(true);
    const draft = gatedDraftPort();
    let fail = true;
    const synced: (DraftEnvelope | null)[] = [];
    const c = createOfflineController({
      connectivity: net.port,
      draftPort: draft.port,
      draftKey: KEY,
      collectDraft: draftInput,
      sync: async (envelope) => {
        synced.push(envelope);
        if (fail) throw new Error('PATCH 失败');
      },
      now: CLOCK,
    });
    c.start();
    net.set(false);
    await flush();
    net.set(true);
    await flush();
    draft.releaseNext();
    await flush();
    expect(c.getState().phase).toBe('sync-failed');
    expect(draft.store.has(KEY)).toBe(true);
    expect(draft.calls).toEqual([`save:${KEY}`, `saved:${KEY}`, `load:${KEY}`]);

    fail = false;
    c.retry();
    await flush();
    expect(synced).toHaveLength(2);
    expect(synced[1]?.payload).toEqual({ text: '我断网时写的一段' });
    expect(draft.calls).toEqual([
      `save:${KEY}`,
      `saved:${KEY}`,
      `load:${KEY}`,
      `load:${KEY}`,
      `clear:${KEY}`,
    ]);
    expect(c.getState()).toMatchObject({ phase: 'synced', pending: false });
    expect(draft.store.size).toBe(0);
    c.stop();
  });

  it('不变量5：代际防护未被拆——sync 飞行中再断网，旧同步结果作废且不 clear', async () => {
    const net = fakeConnectivity(false);
    const draft = fakeDraftPort();
    let release: () => void = () => {};
    const c = createOfflineController({
      connectivity: net.port,
      draftPort: draft.port,
      draftKey: KEY,
      collectDraft: draftInput,
      sync: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      now: CLOCK,
    });
    c.start();
    await flush();
    net.set(true);
    await flush();
    expect(c.getState().phase).toBe('syncing');
    net.set(false);
    await flush();
    release();
    await flush();
    expect(c.getState()).toMatchObject({ phase: 'offline', online: false });
    expect(draft.calls).toEqual([`save:${KEY}`, `load:${KEY}`, `save:${KEY}`]);
    expect(draft.store.has(KEY)).toBe(true);
    c.stop();
  });

  it('写入串行：慢 save 期间连续断网/恢复两次，clear 之后不再落盘孤儿副本', async () => {
    const net = fakeConnectivity(true);
    const draft = gatedDraftPort();
    let n = 0;
    const synced: (DraftEnvelope | null)[] = [];
    const c = createOfflineController({
      connectivity: net.port,
      draftPort: draft.port,
      draftKey: KEY,
      collectDraft: () => {
        n += 1;
        return { payload: { text: `第${n}次` } };
      },
      sync: async (envelope) => {
        synced.push(envelope);
      },
      now: CLOCK,
    });
    c.start();
    net.set(false);
    net.set(true);
    net.set(false);
    net.set(true);
    await flush();
    expect(draft.pendingSaves()).toBe(1); // 第二次 save 排在第一次后面
    draft.releaseNext();
    await flush();
    expect(draft.pendingSaves()).toBe(1);
    draft.releaseNext();
    await flush();
    expect(draft.calls).toEqual([
      `save:${KEY}`,
      `saved:${KEY}`,
      `save:${KEY}`,
      `saved:${KEY}`,
      `load:${KEY}`,
      `clear:${KEY}`,
    ]);
    expect(synced).toHaveLength(1);
    expect(synced[0]?.payload).toEqual({ text: '第2次' });
    expect(c.getState()).toMatchObject({ phase: 'synced', pending: false });
    expect(draft.store.size).toBe(0);
    c.stop();
  });

  it('不变量6：没有自动重试——sync-failed 后多次 flush 也不会自己再同步', async () => {
    const net = fakeConnectivity(false);
    const draft = fakeDraftPort();
    let attempts = 0;
    const c = createOfflineController({
      connectivity: net.port,
      draftPort: draft.port,
      draftKey: KEY,
      collectDraft: draftInput,
      sync: async () => {
        attempts += 1;
        throw new Error('still failing');
      },
      now: CLOCK,
    });
    c.start();
    await flush();
    net.set(true);
    await flush();
    await flush();
    await flush();
    expect(attempts).toBe(1);
    expect(c.getState().phase).toBe('sync-failed');
    c.stop();
  });
});

describe('P2：暂存飞行中必须是可观测状态，横幅不得先谎称没改动', () => {
  it('save 飞行中：stashing=true，文案说「正在暂存」而非「没有需要暂存的改动」', async () => {
    const net = fakeConnectivity(true);
    const draft = gatedDraftPort();
    const c = createOfflineController({
      connectivity: net.port,
      draftPort: draft.port,
      draftKey: KEY,
      collectDraft: draftInput,
      now: CLOCK,
    });
    c.start();
    net.set(false);
    await flush();
    expect(c.getState()).toMatchObject({ phase: 'offline', stashing: true, stashed: false });
    const during = offlineCopy(c.getState(), true);
    expect(during.text).toContain('正在把改动暂存到本机');
    expect(during.text).not.toContain('没有需要暂存的改动');
    expect(during.text).not.toContain('已暂存在本机');
    expect(during).toMatchObject({ tone: 'info', role: 'status' });

    draft.releaseNext();
    await flush();
    expect(c.getState()).toMatchObject({ stashing: false, stashed: true, pending: true });
    expect(offlineCopy(c.getState(), true).text).toContain('已暂存在本机');
    c.stop();
  });

  it('collectDraft 为 null：飞行窗口立即结束，之后才说没有改动', async () => {
    const net = fakeConnectivity(true);
    const draft = gatedDraftPort();
    const c = createOfflineController({
      connectivity: net.port,
      draftPort: draft.port,
      draftKey: KEY,
      collectDraft: () => null,
      now: CLOCK,
    });
    c.start();
    net.set(false);
    await flush();
    expect(c.getState().stashing).toBe(false);
    expect(draft.pendingSaves()).toBe(0);
    expect(offlineCopy(c.getState(), true).text).toContain('没有需要暂存的改动');
    c.stop();
  });

  it('没接端口时 stashing 恒为 false（不假装在暂存）', async () => {
    const net = fakeConnectivity(true);
    const c = createOfflineController({ connectivity: net.port, now: CLOCK });
    c.start();
    net.set(false);
    await flush();
    expect(c.getState().stashing).toBe(false);
    expect(offlineCopy(c.getState(), false).text).toContain('无法保存到服务器');
    c.stop();
  });

  it('重试暂存飞行中：stashing 与 stashFailed 同时为真，只说「正在暂存」，不谎称内容已安全', async () => {
    const net = fakeConnectivity(true);
    const calls: string[] = [];
    let attempt = 0;
    let release: () => void = () => {};
    const port: DraftPort = {
      save: async () => {
        attempt += 1;
        calls.push(`save${attempt}`);
        if (attempt === 1) throw new Error('IndexedDB 不可用');
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        calls.push('saved2');
      },
      load: async () => null,
      clear: async () => {},
    };
    const c = createOfflineController({
      connectivity: net.port,
      draftPort: port,
      draftKey: KEY,
      collectDraft: draftInput,
      now: CLOCK,
    });
    c.start();
    net.set(false);
    await flush();
    expect(c.getState()).toMatchObject({ stashing: false, stashFailed: true, stashed: false });
    expect(offlineCopy(c.getState(), true)).toMatchObject({ tone: 'danger', role: 'alert' });

    c.retry();
    expect(c.getState()).toMatchObject({ stashing: true, stashFailed: true });
    await flush();
    expect(c.getState()).toMatchObject({ stashing: true, stashFailed: true });
    const during = offlineCopy(c.getState(), true);
    expect(during.text).toContain('正在把改动暂存到本机');
    expect(during.text).not.toContain('已暂存在本机');
    expect(during).toMatchObject({ tone: 'info', role: 'status' });

    release();
    await flush();
    expect(calls).toEqual(['save1', 'save2', 'saved2']);
    expect(c.getState()).toMatchObject({ stashing: false, stashed: true, stashFailed: false });
    expect(offlineCopy(c.getState(), true).text).toContain('已暂存在本机');
    c.stop();
  });
});