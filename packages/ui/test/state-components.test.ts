import { createElement } from 'react';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EmptyState } from '../src/state/EmptyState';
import { ErrorState } from '../src/state/ErrorState';
import { LoadingState } from '../src/state/LoadingState';
import { OfflineBanner } from '../src/state/OfflineBanner';
import { PartialSuccessState } from '../src/state/PartialSuccessState';
import { recoveryToActions, retryHintOf } from '../src/state/actions';
import { resolveErrorUi } from '../src/state/error-map';
import type { OfflineControllerOptions } from '../src/state/offline';
import type { ConnectivityPort, DraftPort } from '../src/state/ports';
import type { PartialItem } from '../src/state/partial';
import type { RecoveryAction, StateAction } from '../src/state/types';
import { errorFixture } from './state-fixtures';

/**
 * 组件层测试。
 *
 * 为什么用 React.createElement + renderToStaticMarkup 而不是 JSX +  testing-library：
 * vitest.config.ts 的 include 只收 `**\/test/**\/*.test.ts`，`.test.tsx` 不会被收集；
 * 且本仓库没装 jsdom / testing-library（T-08 不加依赖）。
 * 因此：结构与文案用 SSR  markup 断言，交互回调用抽出来的纯函数断言，
 * 真实的浏览器行为（离线切换、点击、对比度）另用 headless Chrome 实测，见报告。
 */

const html = (node: ReactElement): string => renderToStaticMarkup(node);
const countOf = (markup: string, needle: string): number => markup.split(needle).length - 1;

describe('EmptyState：文案与动作全部来自 props', () => {
  it('渲染传入的标题、说明与动作', () => {
    const markup = html(
      createElement(EmptyState, {
        title: '还没有作品',
        description: '先建一个作品，把想讲的知识点丢进来。',
        actions: [{ key: 'new', label: '新建作品', primary: true }],
      }),
    );
    expect(markup).toContain('还没有作品');
    expect(markup).toContain('先建一个作品，把想讲的知识点丢进来。');
    expect(markup).toContain('新建作品');
    expect(markup).toContain('data-tone="neutral"');
    expect(markup).toContain('role="status"');
  });

  it('同一组件换 props 就是另一屏的空态（证明没有写死业务）', () => {
    const search = html(
      createElement(EmptyState, {
        title: '没有搜到结果',
        actions: [
          { key: 'retry', label: '换个词再搜' },
          { key: 'import', label: '直接导入素材' },
        ],
      }),
    );
    expect(search).toContain('换个词再搜');
    expect(search).toContain('直接导入素材');
    expect(search).not.toContain('还没有作品');
    // 通用组件里不得出现任何一屏的业务路由或平台名。
    expect(search).not.toContain('/studio');
    expect(search).not.toContain('抖音');
  });

  it('禁用动作必须给出看得见的原因', () => {
    const markup = html(
      createElement(EmptyState, {
        title: '空库',
        actions: [{ key: 'x', label: '导入', disabled: true, disabledReason: '先选择文件' }],
      }),
    );
    expect(markup).toContain('先选择文件');
    expect(markup).toContain('disabled');
  });

  it('children 可插入屏自己的引导内容', () => {
    const markup = html(
      createElement(EmptyState, { title: '无版本' }, createElement('p', null, '回到派生页')),
    );
    expect(markup).toContain('回到派生页');
  });
});

describe('LoadingState：骨架形状与可访问性', () => {
  it('grid 默认 3×3 = 9 个格子（SPEC §9 素材搜索）', () => {
    const markup = html(createElement(LoadingState, { variant: 'grid' }));
    expect(countOf(markup, 'ks-skel__cell')).toBe(9);
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('role="status"');
  });

  it('text 默认三段骨架（SPEC §9 文案编辑）', () => {
    expect(countOf(html(createElement(LoadingState, { variant: 'text' })), 'ks-skel__para')).toBe(3);
  });

  it('cards / list / inline 的默认数量与自定义数量', () => {
    expect(countOf(html(createElement(LoadingState, {})), 'ks-skel__card')).toBe(3);
    expect(countOf(html(createElement(LoadingState, { variant: 'list' })), 'ks-skel__row')).toBe(5);
    expect(
      countOf(html(createElement(LoadingState, { variant: 'list', count: 2 })), 'ks-skel__row'),
    ).toBe(2);
  });

  it('label 进 sr-only 区域，hint 可见', () => {
    const markup = html(
      createElement(LoadingState, { variant: 'grid', label: '正在聚合素材', hint: '已抓到 2/4 类来源' }),
    );
    expect(markup).toContain('ks-sr-only');
    expect(markup).toContain('正在聚合素材');
    expect(markup).toContain('已抓到 2/4 类来源');
  });

  it('dimmed + children：已有内容降透明且 aria-hidden，骨架覆盖其上', () => {
    const markup = html(
      createElement(
        LoadingState,
        { variant: 'grid', dimmed: true },
        createElement('div', null, '上一批角度'),
      ),
    );
    expect(markup).toContain('data-overlay="true"');
    expect(markup).toContain('ks-loading__behind');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain('上一批角度');
  });

  it('非 dimmed 时已有内容保留在骨架下方（不丢已到的部分结果）', () => {
    const markup = html(
      createElement(LoadingState, { variant: 'list' }, createElement('div', null, '已到的部分结果')),
    );
    expect(markup).toContain('已到的部分结果');
    expect(markup).not.toContain('ks-loading__behind');
  });

  it('骨架里没有任何硬编码色值（颜色只走 token）', () => {
    const markup = html(createElement(LoadingState, { variant: 'cards' }));
    expect(markup).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(markup).not.toContain('rgb(');
  });
});

describe('ErrorState：按 code 渲染，message 只兜底', () => {
  it('402：标题/文案/动作全部来自映射表', () => {
    const markup = html(
      createElement(ErrorState, { error: errorFixture('QUOTA_INSUFFICIENT') }),
    );
    expect(markup).toContain('点数不够了');
    expect(markup).toContain('这一步需要 2 点，当前可用 1 点');
    expect(markup).toContain('升级或等待重置');
    expect(markup).toContain('data-level="modal"');
    expect(markup).toContain('data-tone="warning"');
  });

  it('422：阻断文案 + 修复路径', () => {
    const markup = html(createElement(ErrorState, { error: errorFixture('COMPLIANCE_BLOCKED') }));
    expect(markup).toContain('有阻断项，暂时不能导出');
    expect(markup).toContain('2 处需要处理');
    expect(markup).toContain('去修复合规项');
    expect(markup).toContain('data-tone="danger"');
  });

  it('502：整页错误 + 重试 + 联系支持，并明说输入还在', () => {
    const markup = html(createElement(ErrorState, { error: errorFixture('UPSTREAM_FAILED') }));
    expect(markup).toContain('data-level="page"');
    expect(markup).toContain('重试');
    expect(markup).toContain('联系支持');
    expect(markup).toContain('你的输入都还在');
  });

  it('notice 承载屏级补充信息（SPEC §9 视频预览「额度已退」）', () => {
    const markup = html(
      createElement(ErrorState, {
        title: '渲染失败',
        description: '这一层没算出来。',
        notice: '预扣的 2 点已退回',
        actions: [{ key: 'retry', label: '重试', primary: true }],
      }),
    );
    expect(markup).toContain('预扣的 2 点已退回');
    expect(markup).toContain('渲染失败');
  });

  it('message 只在映射文案为空时出现', () => {
    const fixture = errorFixture('UNSUPPORTED_MEDIA_TYPE');
    const markup = html(
      createElement(ErrorState, {
        error: { ...fixture, details: { allowed: [] }, message: '服务端说这种格式不行' },
      }),
    );
    expect(markup).toContain('服务端说这种格式不行');
    const normal = html(createElement(ErrorState, { error: fixture }));
    expect(normal).toContain('目前只接受：image/png、image/jpeg、audio/mpeg。');
    expect(normal).not.toContain('unsupported media type');
  });

  it('props 可覆盖映射结果（屏内降级）', () => {
    const markup = html(
      createElement(ErrorState, {
        error: errorFixture('UPSTREAM_FAILED'),
        level: 'section',
        title: '这一列没抓回来',
        description: '其它三类已经可用。',
      }),
    );
    expect(markup).toContain('data-level="section"');
    expect(markup).toContain('这一列没抓回来');
    expect(markup).not.toContain('上游服务暂时不可用');
  });

  it('闸门错误在 page 级别复用既有 GateLocked，不另抄一份闸门文案', () => {
    const markup = html(createElement(ErrorState, { error: errorFixture('GATE_NOT_SATISFIED') }));
    expect(markup).toContain('ks-gate-locked');
    expect(markup).toContain('高清渲染门 G3未解锁');
    expect(markup).toContain('回到上一门');
  });

  it('闸门错误传入服务端 gateDetail 时用 reason 文案', () => {
    const markup = html(
      createElement(ErrorState, {
        error: errorFixture('GATE_NOT_SATISFIED'),
        gateDetail: {
          satisfied: false,
          reason: 'HD_RENDER_NOT_SUCCEEDED',
          redirectTo: '/studio/w1/video',
        },
      }),
    );
    expect(markup).toContain('高清渲染还没完成');
  });

  it('闸门错误降级为 section 时走通用外壳（派生页里的一块锁定区）', () => {
    const markup = html(
      createElement(ErrorState, { error: errorFixture('GATE_NOT_SATISFIED'), level: 'section' }),
    );
    expect(markup).not.toContain('ks-gate-locked');
    expect(markup).toContain('这一步还没解锁');
    expect(markup).toContain('data-level="section"');
  });

  it('没有 error 也没有 title 时有兜底标题，不渲染空白', () => {
    expect(html(createElement(ErrorState, {}))).toContain('出了点问题');
  });

  it('屏自己的动作排在恢复动作之后', () => {
    const markup = html(
      createElement(ErrorState, {
        error: errorFixture('RATE_LIMITED'),
        actions: [{ key: 'back', label: '先回工作台' }],
      }),
    );
    expect(markup.indexOf('重试')).toBeLessThan(markup.indexOf('先回工作台'));
  });

  it('渲染结果里不含任何硬编码色值', () => {
    const markup = html(createElement(ErrorState, { error: errorFixture('STALE_ASSET') }));
    expect(markup).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});

describe('recoveryToActions：恢复动作 → 按钮，回调真的接上', () => {
  const actions: readonly RecoveryAction[] = [
    { kind: 'retry', label: '重试', retryAfterSec: 30 },
    { kind: 'contact-support', label: '联系支持', port: 'llm', providers: ['qwen'] },
  ];

  it('第一个动作是主行动，回调收到原始动作对象', () => {
    const seen: RecoveryAction[] = [];
    const buttons = recoveryToActions(actions, (a) => seen.push(a));
    expect(buttons.map((b) => b.primary)).toEqual([true, false]);
    expect(buttons.every((b) => b.disabled !== true)).toBe(true);
    buttons[0]?.onClick?.();
    buttons[1]?.onClick?.();
    expect(seen).toEqual(actions);
  });

  it('没接回调时：跳转类退化为链接，其余禁用并说明原因', () => {
    const nav: RecoveryAction[] = [
      { kind: 'navigate', label: '回到上一门', to: '/studio/w1/video' },
      { kind: 'relogin', label: '重新登录', loginUrl: '/login', returnTo: '/studio/w1/script' },
      { kind: 'retry', label: '重试' },
    ];
    const buttons = recoveryToActions(nav);
    expect(buttons[0]?.href).toBe('/studio/w1/video');
    expect(buttons[1]?.href).toBe('/login?returnTo=%2Fstudio%2Fw1%2Fscript');
    expect(buttons[2]?.disabled).toBe(true);
    expect(buttons[2]?.disabledReason).toBeTruthy();
  });

  it('接了回调时优先用回调（SPA 内跳转），不再给 href', () => {
    const buttons = recoveryToActions([{ kind: 'navigate', label: '去', to: '/x' }], () => {});
    expect(buttons[0]?.href).toBeUndefined();
    expect(buttons[0]?.onClick).toBeTypeOf('function');
  });

  it('retryHintOf 只在真的要等的时候给提示', () => {
    expect(retryHintOf({ kind: 'retry', label: '重试', retryAfterSec: 30 })).toBe('30 秒后可重试');
    expect(retryHintOf({ kind: 'retry', label: '重试', retryAfterSec: 0 })).toBeUndefined();
    expect(retryHintOf({ kind: 'retry', label: '重试' })).toBeUndefined();
    expect(retryHintOf({ kind: 'go-back', label: '返回' })).toBeUndefined();
  });

  it('15 个码的动作都能转成按钮，且每个都有 label', () => {
    for (const code of [
      'VALIDATION_FAILED',
      'UNAUTHENTICATED',
      'QUOTA_INSUFFICIENT',
      'NOT_FOUND',
      'GATE_NOT_SATISFIED',
      'RENDER_IN_PROGRESS',
      'SCRIPT_LOCKED',
      'AUTOSAVE_CONFLICT',
      'STALE_ASSET',
      'UPLOAD_TOO_LARGE',
      'UNSUPPORTED_MEDIA_TYPE',
      'COMPLIANCE_BLOCKED',
      'RATE_LIMITED',
      'UPSTREAM_FAILED',
      'RENDER_QUEUE_UNAVAILABLE',
    ] as const) {
      const resolved = resolveErrorUi(errorFixture(code));
      const buttons = recoveryToActions(resolved.actions, () => {});
      expect(buttons.length, code).toBe(resolved.actions.length);
      for (const b of buttons) expect(b.label.trim(), code).not.toBe('');
    }
  });
});

describe('PartialSuccessState：逐项标记 + 逐项恢复', () => {
  const items: PartialItem[] = [
    { key: 'a', label: '知乎', status: 'success', detail: '12 条' },
    { key: 'b', label: '公众号', status: 'failed', detail: '抓取超时' },
    { key: 'c', label: '书籍', status: 'skipped', detail: '未配置来源' },
  ];

  it('渲染逐项状态、说明与汇总', () => {
    const markup = html(createElement(PartialSuccessState, { items }));
    expect(markup).toContain('部分完成');
    expect(markup).toContain('共 3 项：成功 1、失败 1、跳过 1。');
    expect(markup).toContain('data-status="failed"');
    expect(markup).toContain('抓取超时');
    expect(markup).toContain('已跳过');
  });

  it('失败项自动挂重试按钮，成功项不挂', () => {
    const markup = html(
      createElement(PartialSuccessState, { items, onRetryItem: () => {}, itemActionLabel: '单独重试' }),
    );
    // 按钮文本节点只出现一次（aria-label 里还有一份，故按 >文本< 计数）。
    expect(countOf(markup, '>单独重试<')).toBe(1);
  });

  it('屏显式给的逐项动作优先（例如「成功项先下载」）', () => {
    const withAction: PartialItem[] = [
      { key: 'a', label: '抖音版', status: 'success', action: { key: 'dl', label: '先下载' } },
      { key: 'b', label: '视频号版', status: 'failed' },
    ];
    const markup = html(
      createElement(PartialSuccessState, { items: withAction, onRetryItem: () => {} }),
    );
    expect(markup).toContain('先下载');
    expect(markup).toContain('重试');
  });

  it('全成功 / 全失败 / 空列表的标题与色调', () => {
    const ok = html(
      createElement(PartialSuccessState, { items: [{ key: 'a', label: 'x', status: 'success' }] }),
    );
    expect(ok).toContain('全部完成');
    expect(ok).toContain('data-tone="success"');
    const bad = html(
      createElement(PartialSuccessState, { items: [{ key: 'a', label: 'x', status: 'failed' }] }),
    );
    expect(bad).toContain('全部失败');
    expect(bad).toContain('data-tone="danger"');
    expect(html(createElement(PartialSuccessState, { items: [] }))).toContain('没有可处理的项目');
  });

  it('整体动作区承载「重试全部失败项」这类屏级 CTA', () => {
    const actions: StateAction[] = [{ key: 'all', label: '重试全部失败项', primary: true }];
    expect(html(createElement(PartialSuccessState, { items, actions }))).toContain('重试全部失败项');
  });
});

describe('OfflineBanner：联网状态决定渲染，文案不撒谎', () => {
  const net = (online: boolean): ConnectivityPort => ({
    isOnline: () => online,
    subscribe: () => () => {},
  });
  const unusedPort: DraftPort = {
    save: async () => {},
    load: async () => null,
    clear: async () => {},
  };

  it('在线时不渲染任何横幅', () => {
    expect(html(createElement(OfflineBanner, { connectivity: net(true) }))).toBe('');
  });

  it('离线时渲染顶部横幅（role=status）', () => {
    const markup = html(createElement(OfflineBanner, { connectivity: net(false) }));
    expect(markup).toContain('ks-offline');
    expect(markup).toContain('data-phase="offline"');
    expect(markup).toContain('网络已断开');
    expect(markup).toContain('role="status"');
  });

  it('没接暂存端口时不得声称已暂存', () => {
    const markup = html(createElement(OfflineBanner, { connectivity: net(false) }));
    expect(markup).not.toContain('已暂存');
  });

  it('接了端口但屏没给 collectDraft：同样不声称已暂存', () => {
    const markup = html(
      createElement(OfflineBanner, {
        connectivity: net(false),
        draftPort: unusedPort,
        draftKey: 'w1',
      }),
    );
    expect(markup).not.toContain('已暂存在本机');
  });

  it('端口/回调都是可选的：最小用法不崩', () => {
    const options: OfflineControllerOptions = { connectivity: net(false) };
    expect(options.connectivity.isOnline()).toBe(false);
    expect(html(createElement(OfflineBanner, { connectivity: net(false), onDismiss: () => {} }))).toContain(
      'ks-offline',
    );
  });
});