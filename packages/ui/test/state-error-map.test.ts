import { describe, expect, it } from 'vitest';
import { ERROR_CODES, ERROR_HTTP_STATUS } from '@knowstudio/contracts';
import type { ErrorCode } from '@knowstudio/contracts';
import { ERROR_UI, isServerError, resolveErrorUi } from '../src/state/error-map';
import type { PresentationLevel, RecoveryKind, StateTone } from '../src/state/types';
import { ALL_FIXTURES, FIXED_TIME, errorFixture } from './state-fixtures';

/**
 * 映射表的穷举性与逐码规格（T-08 验收①②）。
 * 编译期已有 `satisfies ErrorUiMap` + switch 穷举两道闸门，这里是运行期的第三道：
 * 直接对着 contracts 的 ERROR_CODES 逐个点名，漏一个就红。
 */

const LEVELS: readonly PresentationLevel[] = ['page', 'section', 'inline', 'banner', 'modal'];
const TONES: readonly StateTone[] = ['neutral', 'info', 'success', 'warning', 'danger'];

/** 每个码期望的恢复动作类型（顺序即主次）。这张表是 T-08 的验收清单。 */
const EXPECTED_RECOVERY: Record<ErrorCode, readonly RecoveryKind[]> = {
  VALIDATION_FAILED: ['fix-fields'],
  UNAUTHENTICATED: ['relogin'],
  QUOTA_INSUFFICIENT: ['upgrade-or-wait'],
  NOT_FOUND: ['go-back'],
  GATE_NOT_SATISFIED: ['navigate'],
  RENDER_IN_PROGRESS: ['view-job'],
  SCRIPT_LOCKED: ['navigate'],
  AUTOSAVE_CONFLICT: ['choose-version'],
  STALE_ASSET: ['rerender'],
  UPLOAD_TOO_LARGE: ['shrink-upload'],
  UNSUPPORTED_MEDIA_TYPE: ['convert-upload'],
  COMPLIANCE_BLOCKED: ['fix-compliance'],
  RATE_LIMITED: ['retry'],
  UPSTREAM_FAILED: ['retry', 'contact-support'],
  RENDER_QUEUE_UNAVAILABLE: ['retry'],
};

/** 每个码期望消费的 details 字段。 */
const EXPECTED_DETAILS: Record<ErrorCode, readonly string[]> = {
  VALIDATION_FAILED: ['fields'],
  UNAUTHENTICATED: ['loginUrl'],
  QUOTA_INSUFFICIENT: ['need', 'left', 'resetAt', 'options'],
  NOT_FOUND: [],
  GATE_NOT_SATISFIED: ['requiredGate', 'redirectTo', 'reason'],
  RENDER_IN_PROGRESS: ['activeJobId'],
  SCRIPT_LOCKED: ['unlockUrl'],
  AUTOSAVE_CONFLICT: ['serverVersion', 'serverSnapshot', 'clientSnapshot'],
  STALE_ASSET: ['scriptVersion', 'assetVersion'],
  UPLOAD_TOO_LARGE: ['maxBytes'],
  UNSUPPORTED_MEDIA_TYPE: ['allowed'],
  COMPLIANCE_BLOCKED: ['reportId', 'blockingItems'],
  RATE_LIMITED: ['retryAfterSec'],
  UPSTREAM_FAILED: ['port', 'providers'],
  RENDER_QUEUE_UNAVAILABLE: ['retryAfterSec'],
};

describe('映射表对 ERROR_CODES 编译期 + 运行期穷举', () => {
  it('键集合与 contracts 的 ERROR_CODES 完全一致（多一个少一个都失败）', () => {
    expect(Object.keys(ERROR_UI).sort()).toEqual([...ERROR_CODES].sort());
  });

  it('当前契约共 15 个码，映射表也是 15 项', () => {
    expect(ERROR_CODES).toHaveLength(15);
    expect(Object.keys(ERROR_UI)).toHaveLength(15);
  });

  it('不另立错误码枚举：映射表的键全部来自 contracts', () => {
    for (const key of Object.keys(ERROR_UI)) {
      expect(ERROR_CODES, key).toContain(key);
    }
  });

  for (const code of ERROR_CODES) {
    it(`${code}：entry 完整（级别/色调/标题/文案/恢复动作/details 清单）`, () => {
      const entry = ERROR_UI[code];
      expect(LEVELS, code).toContain(entry.level);
      expect(TONES, code).toContain(entry.tone);
      expect(entry.title.trim(), code).not.toBe('');
      expect(typeof entry.body, code).toBe('function');
      expect(typeof entry.recovery, code).toBe('function');
      expect(typeof entry.keepUserInput, code).toBe('boolean');
      expect(Array.isArray(entry.detailsUsed), code).toBe(true);
    });
  }
});

describe('逐码恢复动作类型（验收②）', () => {
  for (const code of ERROR_CODES) {
    it(`${code} → ${EXPECTED_RECOVERY[code].join(' + ')}`, () => {
      const resolved = resolveErrorUi(errorFixture(code), { formatTime: FIXED_TIME });
      expect(resolved.actions.map((a) => a.kind)).toEqual(EXPECTED_RECOVERY[code]);
      // 每个动作都必须有用户可读的 CTA 文案。
      for (const action of resolved.actions) expect(action.label.trim(), code).not.toBe('');
    });
  }

  it('EXPECTED_RECOVERY 自身也穷举 15 个码（防止验收表漏项）', () => {
    expect(Object.keys(EXPECTED_RECOVERY).sort()).toEqual([...ERROR_CODES].sort());
    expect(Object.keys(EXPECTED_DETAILS).sort()).toEqual([...ERROR_CODES].sort());
  });
});

describe('逐码消费的 details 字段', () => {
  for (const code of ERROR_CODES) {
    it(`${code} 消费 ${EXPECTED_DETAILS[code].join('/') || '（无 details）'}`, () => {
      const entry = ERROR_UI[code];
      expect([...entry.detailsUsed].sort()).toEqual([...EXPECTED_DETAILS[code]].sort());
      // 声明消费的字段必须真的存在于契约 details 里（NOT_FOUND 是空对象）。
      const keys = Object.keys(errorFixture(code).details);
      for (const used of entry.detailsUsed) expect(keys, `${code}.${used}`).toContain(used);
    });
  }

  it('声明的字段真的影响输出：改 details 会改文案或动作载荷', () => {
    const quota = errorFixture('QUOTA_INSUFFICIENT');
    const base = resolveErrorUi(quota, { formatTime: FIXED_TIME });
    const changed = resolveErrorUi(
      { ...quota, details: { ...quota.details, need: 99, left: 0 } },
      { formatTime: FIXED_TIME },
    );
    expect(changed.body).not.toBe(base.body);
    expect(changed.actions[0]).toMatchObject({ kind: 'upgrade-or-wait', need: 99, left: 0 });

    const stale = errorFixture('STALE_ASSET');
    expect(resolveErrorUi(stale).body).toContain('9');
    expect(resolveErrorUi(stale).body).toContain('4');
  });
});

describe('呈现级别与「不丢用户输入」（SPEC §9 全局规则）', () => {
  for (const code of ERROR_CODES) {
    const status = ERROR_HTTP_STATUS[code];
    if (status >= 500) {
      it(`${code} 是 5xx：统一错误页 + 重试 + 保留用户输入`, () => {
        const resolved = resolveErrorUi(errorFixture(code), { formatTime: FIXED_TIME });
        expect(resolved.level).toBe('page');
        expect(resolved.keepUserInput).toBe(true);
        expect(resolved.actions.some((a) => a.kind === 'retry')).toBe(true);
      });
    }
  }

  it('isServerError 只认契约里的 HTTP 状态表', () => {
    expect(ERROR_CODES.filter(isServerError)).toEqual([
      'UPSTREAM_FAILED',
      'RENDER_QUEUE_UNAVAILABLE',
    ]);
  });

  it('就地呈现的错误态一律保留用户输入', () => {
    for (const code of ERROR_CODES) {
      const entry = ERROR_UI[code];
      if (entry.level !== 'page') expect(entry.keepUserInput, code).toBe(true);
    }
  });

  it('402 是弹层（明确提示 + 升级/等待），422 是就地阻断（禁用导出 + 修复路径）', () => {
    expect(ERROR_UI.QUOTA_INSUFFICIENT.level).toBe('modal');
    expect(ERROR_UI.COMPLIANCE_BLOCKED.level).toBe('section');
    expect(ERROR_UI.COMPLIANCE_BLOCKED.tone).toBe('danger');
    expect(ERROR_UI.AUTOSAVE_CONFLICT.level).toBe('modal');
    expect(ERROR_UI.SCRIPT_LOCKED.level).toBe('banner');
    expect(ERROR_UI.RATE_LIMITED.level).toBe('banner');
  });
});

describe('resolveErrorUi 的载荷保真', () => {
  it('401 带上 returnTo（SPEC §9：/login?returnTo=）', () => {
    const resolved = resolveErrorUi(errorFixture('UNAUTHENTICATED'), {
      returnTo: '/studio/w1/script?tab=body',
    });
    expect(resolved.actions[0]).toEqual({
      kind: 'relogin',
      label: '重新登录',
      loginUrl: '/login',
      returnTo: '/studio/w1/script?tab=body',
    });
  });

  it('402 把 need/left/resetAt/options 原样交给 UI，不自己算额度', () => {
    const fixture = errorFixture('QUOTA_INSUFFICIENT');
    const resolved = resolveErrorUi(fixture, { formatTime: FIXED_TIME });
    expect(resolved.actions[0]).toEqual({
      kind: 'upgrade-or-wait',
      label: '升级或等待重置',
      need: 2,
      left: 1,
      resetAt: '2026-12-01T00:00:00Z',
      options: fixture.details.options,
    });
    expect(resolved.body).toContain('〔2026-12-01T00:00:00Z〕');
  });

  it('409 AUTOSAVE_CONFLICT 双版本快照都带上，绝不替用户选', () => {
    const fixture = errorFixture('AUTOSAVE_CONFLICT');
    const action = resolveErrorUi(fixture).actions[0];
    expect(action).toMatchObject({ kind: 'choose-version', serverVersion: 7 });
    if (action?.kind !== 'choose-version') throw new Error('类型收窄失败');
    expect(action.serverSnapshot).toEqual(fixture.details.serverSnapshot);
    expect(action.clientSnapshot).toEqual(fixture.details.clientSnapshot);
    expect(action.serverSnapshot).not.toEqual(action.clientSnapshot);
  });

  it('409 GATE_NOT_SATISFIED 额外给出 gate 信息，供屏复用 GateLocked', () => {
    const resolved = resolveErrorUi(errorFixture('GATE_NOT_SATISFIED'));
    expect(resolved.gate).toEqual({
      requiredGate: 'G3',
      redirectTo: '/studio/w1/video',
      reason: 'HD_RENDER_NOT_SUCCEEDED',
    });
    expect(resolved.actions[0]).toMatchObject({ kind: 'navigate', to: '/studio/w1/video' });
  });

  it('只有闸门错误带 gate 信息', () => {
    for (const error of ALL_FIXTURES) {
      const resolved = resolveErrorUi(error);
      if (error.code === 'GATE_NOT_SATISFIED') expect(resolved.gate).toBeDefined();
      else expect(resolved.gate, error.code).toBeUndefined();
    }
  });

  it('422 的 blockingCount 来自 blockingItems，reportId 原样透传', () => {
    const fixture = errorFixture('COMPLIANCE_BLOCKED');
    const action = resolveErrorUi(fixture).actions[0];
    expect(action).toMatchObject({
      kind: 'fix-compliance',
      reportId: 'rpt_1',
      blockingCount: fixture.details.blockingItems.length,
    });
    if (action?.kind !== 'fix-compliance') throw new Error('类型收窄失败');
    expect(action.items).toEqual(fixture.details.blockingItems);
  });

  it('429 / 503 的 retryAfterSec 进入重试动作；0 秒也如实带上', () => {
    expect(resolveErrorUi(errorFixture('RATE_LIMITED')).actions[0]).toMatchObject({
      kind: 'retry',
      retryAfterSec: 30,
    });
    const zero = errorFixture('RENDER_QUEUE_UNAVAILABLE');
    expect(
      resolveErrorUi({ ...zero, details: { retryAfterSec: 0 } }).actions[0],
    ).toMatchObject({ kind: 'retry', retryAfterSec: 0 });
  });

  it('404 文案不区分「不存在」与「不属于你」（架构 §10.1 防枚举探测）', () => {
    const body = resolveErrorUi(errorFixture('NOT_FOUND')).body;
    expect(body).not.toContain('无权');
    expect(body).not.toContain('权限');
    expect(resolveErrorUi(errorFixture('NOT_FOUND')).actions[0]?.kind).toBe('go-back');
  });

  it('每个码的 resolveErrorUi 都返回非空标题与文案', () => {
    for (const error of ALL_FIXTURES) {
      const resolved = resolveErrorUi(error, { formatTime: FIXED_TIME });
      expect(resolved.code).toBe(error.code);
      expect(resolved.title.trim(), error.code).not.toBe('');
      expect(resolved.body.trim(), error.code).not.toBe('');
      expect(resolved.actions.length, error.code).toBeGreaterThan(0);
    }
  });
});