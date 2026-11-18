// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LoginView } from '../LoginView';
import type { LoginViewProps } from '../LoginView';

const base: LoginViewProps = {
  method: 'code',
  onMethodChange: () => {},
  account: '13800000000',
  onAccountChange: () => {},
  credential: '',
  onCredentialChange: () => {},
  onSubmit: () => {},
  onSendCode: () => {},
  pending: false,
  sendingCode: false,
  codeCooldownSec: 0,
  devCode: '123456',
  onDevCodeClose: () => {},
};

afterEach(() => {
  cleanup();
});

describe('LoginView 开发验证码弹窗', () => {
  it('devCode 存在时弹窗展示验证码并支持复制', () => {
    render(<LoginView {...base} />);
    expect(screen.getByText('开发验证码')).toBeTruthy();
    expect(screen.getByTestId('login-dev-code').textContent).toBe('123456');
    expect(screen.getByRole('button', { name: /复制/ })).toBeTruthy();
  });

  it('devCode 为空时不渲染弹窗', () => {
    render(<LoginView {...base} devCode={null} />);
    expect(screen.queryByText('开发验证码')).toBeNull();
  });
});
