import { describe, expect, it } from 'vitest';
import {
  bodyOrMessage,
  formatBytes,
  formatTimestamp,
  formatWaitSeconds,
  loginTarget,
} from '../src/state/format';
import {
  PARTIAL_STATUS_LABEL,
  partialCounts,
  partialItemAction,
  partialSummaryText,
  partialTitle,
  partialTone,
} from '../src/state/partial';
import type { PartialItem } from '../src/state/partial';
import { SKELETON_VARIANTS, skeletonCount } from '../src/state/skeleton';
import type { StateAction } from '../src/state/types';

/** 文案选择与恢复决策的纯函数层：不依赖 DOM，逐个边界钉死。 */

describe('formatBytes（413 的 maxBytes）', () => {
  it('按 1024 进位，保留一位小数', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(20 * 1024 * 1024)).toBe('20 MB');
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3 GB');
  });

  it('非法值不抛异常（服务端给了脏数据也不能白屏）', () => {
    expect(formatBytes(Number.NaN)).toContain('NaN');
    expect(formatBytes(-1)).toBe('-1 B');
  });
});

describe('formatWaitSeconds（429 / 503 的 retryAfterSec）', () => {
  it('0 与负数说「马上」，不写「0 秒后」', () => {
    expect(formatWaitSeconds(0)).toBe('马上');
    expect(formatWaitSeconds(-3)).toBe('马上');
  });

  it('秒 / 分 / 时的边界', () => {
    expect(formatWaitSeconds(30)).toBe('30 秒');
    expect(formatWaitSeconds(59.2)).toBe('60 秒');
    expect(formatWaitSeconds(60)).toBe('1 分钟');
    expect(formatWaitSeconds(120)).toBe('2 分钟');
    expect(formatWaitSeconds(3600)).toBe('1 小时');
    expect(formatWaitSeconds(3660)).toBe('1 小时 1 分钟');
  });
});

describe('formatTimestamp（402 的 resetAt）', () => {
  it('注入 formatter 时原样使用（测试与屏都可控制本地化）', () => {
    expect(formatTimestamp('2026-12-01T00:00:00Z', (iso) => `〔${iso}〕`)).toBe(
      '〔2026-12-01T00:00:00Z〕',
    );
  });

  it('默认本地化输出含年月日，非法时间原样返回不抛异常', () => {
    const out = formatTimestamp('2026-12-01T00:00:00Z');
    expect(out).toContain('2026');
    expect(out).toContain('12');
    expect(formatTimestamp('not-a-date')).toBe('not-a-date');
  });
});

describe('loginTarget（SPEC §9 全局：/login?returnTo=）', () => {
  it('returnTo 必须编码，避免 query 注入', () => {
    expect(loginTarget('/login', '/studio/w1/script?tab=body')).toBe(
      '/login?returnTo=%2Fstudio%2Fw1%2Fscript%3Ftab%3Dbody',
    );
  });

  it('loginUrl 已有 query 时用 & 追加', () => {
    expect(loginTarget('/login?mode=sms', '/studio')).toBe('/login?mode=sms&returnTo=%2Fstudio');
  });

  it('没有 returnTo 时原样返回', () => {
    expect(loginTarget('/login')).toBe('/login');
    expect(loginTarget('/login', '')).toBe('/login');
  });
});

describe('bodyOrMessage（message 的唯一合法用途）', () => {
  it('映射文案优先，空串才用 message，两者皆空给通用兜底', () => {
    expect(bodyOrMessage('  有文案  ', 'ignored')).toBe('有文案');
    expect(bodyOrMessage('   ', ' 服务端原文 ')).toBe('服务端原文');
    expect(bodyOrMessage('', '   ')).toBe('出了点问题，请稍后重试。');
  });
});

describe('partialCounts / partialTone / partialTitle / partialSummaryText', () => {
  const items: PartialItem[] = [
    { key: '1', label: 'a', status: 'success' },
    { key: '2', label: 'b', status: 'failed' },
    { key: '3', label: 'c', status: 'failed' },
    { key: '4', label: 'd', status: 'skipped' },
  ];

  it('计数逐项准确', () => {
    expect(partialCounts(items)).toEqual({ total: 4, success: 1, failed: 2, skipped: 1 });
    expect(partialCounts([])).toEqual({ total: 0, success: 0, failed: 0, skipped: 0 });
  });

  it('色调：全成功 success、全失败 danger、混合 warning', () => {
    expect(partialTone(partialCounts([{ status: 'success' }]))).toBe('success');
    expect(partialTone(partialCounts([{ status: 'failed' }]))).toBe('danger');
    expect(partialTone(partialCounts(items))).toBe('warning');
    expect(partialTone(partialCounts([]))).toBe('warning');
  });

  it('跳过项不算成功：全成功但有跳过仍是「部分完成」', () => {
    const mixed: PartialItem[] = [
      { key: '1', label: 'a', status: 'success' },
      { key: '2', label: 'b', status: 'skipped' },
    ];
    expect(partialTitle(partialCounts(mixed))).toBe('部分完成');
    expect(partialTone(partialCounts(mixed))).toBe('warning');
  });

  it('汇总文案只在有跳过时提跳过', () => {
    expect(partialSummaryText(partialCounts(items))).toBe('共 4 项：成功 1、失败 2、跳过 1。');
    expect(
      partialSummaryText(partialCounts([{ status: 'success' }])),
    ).toBe('共 1 项：成功 1、失败 0。');
  });

  it('三个状态都有中文标签', () => {
    expect(PARTIAL_STATUS_LABEL).toEqual({ success: '成功', failed: '失败', skipped: '已跳过' });
  });
});

describe('partialItemAction：逐项恢复回调真的接上', () => {
  const failed: PartialItem = { key: 'b', label: '公众号', status: 'failed' };

  it('失败项 + 回调 → 生成重试动作，点击把原 item 交回屏', () => {
    const seen: PartialItem[] = [];
    const action = partialItemAction(failed, (item) => seen.push(item), '单独重派生');
    expect(action?.label).toBe('单独重派生');
    action?.onClick?.();
    expect(seen).toEqual([failed]);
  });

  it('成功项与跳过项不挂重试', () => {
    expect(partialItemAction({ key: 'a', label: 'x', status: 'success' }, () => {})).toBeUndefined();
    expect(partialItemAction({ key: 'c', label: 'x', status: 'skipped' }, () => {})).toBeUndefined();
  });

  it('没给回调时不生成动作（不渲染点了没反应的按钮）', () => {
    expect(partialItemAction(failed)).toBeUndefined();
  });

  it('屏显式 action 优先于自动重试', () => {
    const explicit: StateAction = { key: 'dl', label: '先下载' };
    expect(partialItemAction({ ...failed, action: explicit }, () => {})).toBe(explicit);
  });
});

describe('skeletonCount：形状默认值与夹紧', () => {
  it('默认值对齐 SPEC §9（素材搜索 3×3、文案三段）', () => {
    expect(skeletonCount('grid')).toBe(9);
    expect(skeletonCount('text')).toBe(3);
    expect(skeletonCount('cards')).toBe(3);
    expect(skeletonCount('list')).toBe(5);
    expect(skeletonCount('inline')).toBe(1);
  });

  it('夹紧到 1..24，非法值回落默认', () => {
    expect(skeletonCount('grid', 0)).toBe(1);
    expect(skeletonCount('grid', -5)).toBe(1);
    expect(skeletonCount('grid', 999)).toBe(24);
    expect(skeletonCount('grid', 2.9)).toBe(2);
    expect(skeletonCount('grid', Number.NaN)).toBe(9);
  });

  it('五种形状都被穷举', () => {
    expect([...SKELETON_VARIANTS].sort()).toEqual(['cards', 'grid', 'inline', 'list', 'text']);
  });
});