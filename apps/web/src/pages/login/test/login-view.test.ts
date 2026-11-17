import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';
import { RateLimited, Unauthenticated } from '@knowstudio/contracts';
import { LoginView } from '../LoginView';
import type { LoginViewProps } from '../LoginView';

/**
 * 登录页呈现层首帧渲染实测（T-06 / SPEC §3.13）。
 * 手法与 gateCta / gateDeepLink 一致：node 环境 + react-dom/server renderToStaticMarkup，
 * 补 matchMedia 垫片让 antd 响应式组件能在 SSR 下渲染（垫片只影响测试环境，不改应用代码）。
 *
 * 覆盖：初始帧、密码/验证码两种方式、returnTo 保留、契约错误态（按 code）、冷却文案、
 * 字段问题、非契约兜底。**交互行为**（点击→真实请求→cookie→跳转、倒计时推进）SSR 不跑
 * effect/事件，无法覆盖，需真实浏览器，已在交付报告标为阻塞。
 */
beforeAll(() => {
  (globalThis as { matchMedia?: unknown }).matchMedia = (query: string) => ({
    matches: query.includes('960'),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  });
});

const base: LoginViewProps = {
  method: 'password',
  onMethodChange: () => {},
  account: '',
  onAccountChange: () => {},
  credential: '',
  onCredentialChange: () => {},
  onSubmit: () => {},
  onSendCode: () => {},
  pending: false,
  sendingCode: false,
  codeCooldownSec: 0,
  onRecovery: () => {},
};

function render(overrides: Partial<LoginViewProps> = {}): string {
  return renderToStaticMarkup(h(LoginView, { ...base, ...overrides }));
}

const unauthenticated = Unauthenticated.parse({
  code: 'UNAUTHENTICATED',
  message: '未认证或凭证无效',
  details: { loginUrl: '/login' },
});
const rateLimited = RateLimited.parse({
  code: 'RATE_LIMITED',
  message: '请求过于频繁',
  details: { retryAfterSec: 42 },
});

describe('LoginView 初始帧', () => {
  it('渲染登录卡片、账号输入、两种方式与提交按钮', () => {
    const html = render();
    expect(html).toContain('登录');
    expect(html).toContain('手机号 / 邮箱');
    expect(html).toContain('密码登录');
    expect(html).toContain('验证码登录');
    expect(html).toContain('密码');
  });

  it('密码方式渲染密码框，不渲染发码按钮', () => {
    const html = render({ method: 'password' });
    expect(html).toContain('current-password');
    expect(html).not.toContain('发送验证码');
  });

  it('验证码方式渲染验证码框与发码按钮', () => {
    const html = render({ method: 'code' });
    expect(html).toContain('6 位验证码');
    expect(html).toContain('发送验证码');
    expect(html).toContain('one-time-code');
  });

  it('冷却中显示倒计时文案，发码按钮禁用', () => {
    const html = render({ method: 'code', codeCooldownSec: 42 });
    expect(html).toContain('42s 后重发');
    expect(html).not.toContain('>发送验证码<');
  });
});

describe('LoginView · returnTo 保留（开放重定向防线在逻辑层已测，这里测呈现保留）', () => {
  it('合法 returnTo 写进 data-return-to 并给出回跳提示', () => {
    const html = render({ returnTo: '/works/w1' });
    expect(html).toContain('data-return-to="/works/w1"');
    expect(html).toContain('登录后回到 /works/w1');
  });

  it('无 returnTo 时 data-return-to 为空串，不渲染回跳提示', () => {
    const html = render();
    expect(html).toContain('data-return-to=""');
    expect(html).not.toContain('登录后回到');
  });
});

describe('LoginView · 错误态按契约 code 渲染（复用 ErrorState / ERROR_UI）', () => {
  it('UNAUTHENTICATED → 登录语境覆盖文案「账号或凭证不正确」', () => {
    const html = render({ error: unauthenticated });
    expect(html).toContain('data-testid="login-error"');
    expect(html).toContain('账号或凭证不正确');
    // 不沿用通用 401 的「登录状态已过期」（那是会话过期语境）。
    expect(html).not.toContain('登录状态已过期');
  });

  it('RATE_LIMITED → 规范映射「操作太频繁了」+ 服务端 retryAfterSec 文案', () => {
    const html = render({ error: rateLimited });
    expect(html).toContain('data-testid="login-error"');
    expect(html).toContain('操作太频繁了');
    expect(html).toContain('42 秒');
  });

  it('非契约错误（断网）→ 兜底标题 + notice 文案', () => {
    const html = render({ notice: '网络异常，请稍后重试。' });
    expect(html).toContain('data-testid="login-notice"');
    expect(html).toContain('登录暂时不可用');
    expect(html).toContain('网络异常，请稍后重试。');
  });

  it('字段问题内联展示，定位到 path', () => {
    const html = render({ fieldIssues: [{ path: 'account', message: '必填' }] });
    expect(html).toContain('有几项需要修正');
    expect(html).toContain('account：必填');
  });

  it('无错误时不渲染错误态容器', () => {
    const html = render();
    expect(html).not.toContain('data-testid="login-error"');
    expect(html).not.toContain('data-testid="login-notice"');
  });
});