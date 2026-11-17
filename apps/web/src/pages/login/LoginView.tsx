/**
 * 登录页呈现层（T-06 / SPEC §3.13）。纯 props 驱动、无内部状态、无 IO，
 * 故可用 react-dom/server 的 renderToStaticMarkup 在 node 环境做首帧渲染断言
 * （与 gateCta / gateDeepLink 同一手法）。交互行为（点击→请求→跳转、验证码倒计时）
 * 由容器 LoginPage 持有，需真实浏览器覆盖。
 *
 * 错误态复用 @knowstudio/ui 的 ErrorState：分支只看契约 code，文案/恢复动作由 ERROR_UI
 * 派生；登录语境下对 UNAUTHENTICATED 做文案覆盖（loginErrorOverride），不另抄一份映射。
 */
import { Alert, Button, Card, Input, Segmented, Space, Typography } from 'antd';
import { ErrorState } from '@knowstudio/ui';
import type { RecoveryAction } from '@knowstudio/ui';
import type { ApiError } from '@knowstudio/contracts';
import type { LoginMethod } from './auth-client';
import { loginErrorOverride } from './login-logic';
import type { LoginFieldIssue } from './login-logic';

export interface LoginViewProps {
  method: LoginMethod;
  onMethodChange: (method: LoginMethod) => void;
  account: string;
  onAccountChange: (value: string) => void;
  credential: string;
  onCredentialChange: (value: string) => void;
  onSubmit: () => void;
  onSendCode: () => void;
  pending: boolean;
  sendingCode: boolean;
  codeCooldownSec: number;
  /** 契约错误信封（按 code 分支）。 */
  error?: ApiError | null;
  /** 非契约错误（断网 / 未知异常）的兜底文案。 */
  notice?: string | null;
  /** 已校验的站内回跳路径，登录后回到这里。 */
  returnTo?: string;
  fieldIssues?: readonly LoginFieldIssue[];
  onRecovery?: (action: RecoveryAction) => void;
}

const METHOD_OPTIONS: { label: string; value: LoginMethod }[] = [
  { label: '密码登录', value: 'password' },
  { label: '验证码登录', value: 'code' },
];

export function LoginView({
  method,
  onMethodChange,
  account,
  onAccountChange,
  credential,
  onCredentialChange,
  onSubmit,
  onSendCode,
  pending,
  sendingCode,
  codeCooldownSec,
  error,
  notice,
  returnTo,
  fieldIssues,
  onRecovery,
}: LoginViewProps) {
  const override = error == null ? undefined : loginErrorOverride(error);
  const codeDisabled = codeCooldownSec > 0 || sendingCode || account.trim().length === 0;
  const codeLabel = codeCooldownSec > 0 ? `${codeCooldownSec}s 后重发` : '发送验证码';

  return (
    <div className="bare-page">
      <Card title="登录" data-return-to={returnTo ?? ''}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit();
          }}
        >
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Segmented
              block
              options={METHOD_OPTIONS}
              value={method}
              onChange={(value) => onMethodChange(value as LoginMethod)}
            />

            <Input
              size="large"
              value={account}
              autoComplete="username"
              placeholder="手机号 / 邮箱"
              aria-label="账号"
              onChange={(e) => onAccountChange(e.target.value)}
            />

            {method === 'password' ? (
              <Input.Password
                size="large"
                value={credential}
                autoComplete="current-password"
                placeholder="密码"
                aria-label="密码"
                onChange={(e) => onCredentialChange(e.target.value)}
              />
            ) : (
              <Space.Compact style={{ width: '100%' }}>
                <Input
                  size="large"
                  value={credential}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="6 位验证码"
                  aria-label="验证码"
                  onChange={(e) => onCredentialChange(e.target.value)}
                />
                <Button
                  size="large"
                  onClick={onSendCode}
                  disabled={codeDisabled}
                  loading={sendingCode}
                >
                  {codeLabel}
                </Button>
              </Space.Compact>
            )}

            {fieldIssues != null && fieldIssues.length > 0 ? (
              <Alert
                type="warning"
                showIcon
                message="有几项需要修正"
                description={
                  <ul style={{ margin: 0, paddingInlineStart: 18 }}>
                    {fieldIssues.map((issue) => (
                      <li key={issue.path}>{`${issue.path}：${issue.message}`}</li>
                    ))}
                  </ul>
                }
              />
            ) : null}

            {returnTo != null && returnTo.length > 0 ? (
              <Typography.Text type="secondary">{`登录后回到 ${returnTo}`}</Typography.Text>
            ) : null}

            <Button type="primary" size="large" htmlType="submit" block loading={pending}>
              登录
            </Button>

            {error != null ? (
              <ErrorState
                error={error}
                level="inline"
                context={{ returnTo }}
                title={override?.title}
                description={override?.description}
                onRecovery={onRecovery}
                testId="login-error"
              />
            ) : notice != null && notice.length > 0 ? (
              <ErrorState
                title="登录暂时不可用"
                description={notice}
                tone="danger"
                level="inline"
                testId="login-notice"
              />
            ) : null}
          </Space>
        </form>
      </Card>
    </div>
  );
}