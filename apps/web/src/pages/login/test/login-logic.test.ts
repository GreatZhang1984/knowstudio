import { describe, expect, it } from 'vitest';
import { RateLimited, Unauthenticated, ValidationFailed } from '@knowstudio/contracts';
import {
  RETURN_TO_FALLBACK,
  accountKind,
  inferChannel,
  loginErrorOverride,
  parseReturnTo,
  safeRedirectTarget,
  validateLoginInput,
} from '../login-logic';

/**
 * 登录页纯逻辑实测（T-06 / SPEC §3.13）。node 环境，零 DOM。
 * 重点：returnTo 开放重定向防线、错误按 code 分支、校验复用契约。
 */
describe('parseReturnTo · 只收站内相对路径（开放重定向防线）', () => {
  it('合法站内路径原样取回（含 URL 编码）', () => {
    expect(parseReturnTo('?returnTo=%2Fworks%2Fw1')).toBe('/works/w1');
    expect(parseReturnTo('?returnTo=/studio/w1/video')).toBe('/studio/w1/video');
    expect(parseReturnTo('returnTo=/publish/w1/export')).toBe('/publish/w1/export');
  });

  it('协议相对 //evil.com 被丢弃', () => {
    expect(parseReturnTo('?returnTo=%2F%2Fevil.com')).toBeUndefined();
    expect(parseReturnTo('?returnTo=//evil.com')).toBeUndefined();
  });

  it('反斜杠变体 /\\evil.com 被丢弃（部分浏览器等价于 //）', () => {
    expect(parseReturnTo('?returnTo=%2F%5Cevil.com')).toBeUndefined();
    expect(parseReturnTo('?returnTo=/\\evil.com')).toBeUndefined();
  });

  it('绝对 URL 被丢弃', () => {
    expect(parseReturnTo('?returnTo=https%3A%2F%2Fevil.com')).toBeUndefined();
    expect(parseReturnTo('?returnTo=http://evil.com/x')).toBeUndefined();
  });

  it('缺省 / 空串 / 无 returnTo 键 → undefined', () => {
    expect(parseReturnTo('')).toBeUndefined();
    expect(parseReturnTo('?foo=bar')).toBeUndefined();
    expect(parseReturnTo('?returnTo=')).toBeUndefined();
  });

  it('保留 loginUrl 已有 query 之外的额外参数不影响 returnTo 提取', () => {
    expect(parseReturnTo('?theme=dark&returnTo=%2Fworks')).toBe('/works');
  });
});

describe('safeRedirectTarget · 登录后回跳再做一次契约校验（纵深防御）', () => {
  it('合法 returnTo 原样回跳', () => {
    expect(safeRedirectTarget('/works/w1')).toBe('/works/w1');
  });

  it('undefined → 工作台首页', () => {
    expect(safeRedirectTarget(undefined)).toBe(RETURN_TO_FALLBACK);
    expect(safeRedirectTarget(undefined)).toBe('/');
  });

  it('非法值（协议相对 / 绝对 URL）→ 回落首页，绝不跳外站', () => {
    expect(safeRedirectTarget('//evil.com')).toBe('/');
    expect(safeRedirectTarget('https://evil.com')).toBe('/');
    expect(safeRedirectTarget('/\\evil.com')).toBe('/');
  });

  it('自定义 fallback 生效', () => {
    expect(safeRedirectTarget(undefined, '/works')).toBe('/works');
    expect(safeRedirectTarget('//evil.com', '/works')).toBe('/works');
  });
});

describe('inferChannel / accountKind · 渠道推断与 UI 标签', () => {
  it('含 @ → email，否则 sms（与 API 端缺省推断一致）', () => {
    expect(inferChannel('user@example.com')).toBe('email');
    expect(inferChannel('13800000000')).toBe('sms');
  });

  it('accountKind 区分邮箱 / 手机号 / 未知', () => {
    expect(accountKind('user@example.com')).toBe('email');
    expect(accountKind('13800000000')).toBe('phone');
    expect(accountKind('abc')).toBe('unknown');
    expect(accountKind('  user@example.com  ')).toBe('email');
  });
});

describe('validateLoginInput · 复用契约 LoginRequest', () => {
  it('密码登录合法 → ok + 规范化请求体', () => {
    const r = validateLoginInput('13800000000', 'secret', 'password');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual({ account: '13800000000', credential: 'secret', method: 'password' });
  });

  it('验证码登录合法 → ok', () => {
    const r = validateLoginInput('user@example.com', '123456', 'code');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.method).toBe('code');
  });

  it('空账号 / 空凭证 → 字段问题项（path 定位）', () => {
    const r = validateLoginInput('', 'secret', 'password');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.map((i) => i.path)).toContain('account');

    const r2 = validateLoginInput('13800000000', '', 'password');
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.issues.map((i) => i.path)).toContain('credential');
  });
});

describe('loginErrorOverride · 只按 code 分支，不解析 message', () => {
  it('UNAUTHENTICATED → 登录语境文案（账号或凭证不正确）', () => {
    const err = Unauthenticated.parse({
      code: 'UNAUTHENTICATED',
      message: '未认证或凭证无效',
      details: { loginUrl: '/login' },
    });
    const override = loginErrorOverride(err);
    expect(override).toBeDefined();
    expect(override?.title).toBe('账号或凭证不正确');
  });

  it('RATE_LIMITED / VALIDATION_FAILED → undefined（交回 ERROR_UI 规范映射）', () => {
    const limited = RateLimited.parse({
      code: 'RATE_LIMITED',
      message: '请求过于频繁',
      details: { retryAfterSec: 42 },
    });
    expect(loginErrorOverride(limited)).toBeUndefined();

    const invalid = ValidationFailed.parse({
      code: 'VALIDATION_FAILED',
      message: '参数校验失败',
      details: { fields: [{ path: 'account', message: '必填' }] },
    });
    expect(loginErrorOverride(invalid)).toBeUndefined();
  });

  it('message 内容不影响分支（改 message 不改结果）', () => {
    const a = Unauthenticated.parse({ code: 'UNAUTHENTICATED', message: 'AAA', details: { loginUrl: '/login' } });
    const b = Unauthenticated.parse({ code: 'UNAUTHENTICATED', message: 'BBB', details: { loginUrl: '/login' } });
    expect(loginErrorOverride(a)).toEqual(loginErrorOverride(b));
  });
});