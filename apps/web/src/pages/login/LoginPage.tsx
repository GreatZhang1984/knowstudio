/**
 * 登录页容器（T-06 / SPEC §3.13）。持有状态与副作用，把纯逻辑（login-logic）与
 * 数据缝隙（auth-client）接到呈现层（LoginView）。路由接线由协调者做：manifest 的
 * page-login 指到本文件即可（bare 外壳，不套工作台）。
 *
 * 职责边界：
 * - 读取并校验 returnTo（parseReturnTo），登录成功后经 safeRedirectTarget 回跳，杜绝开放重定向。
 * - 登录/发码失败按契约 code 渲染错误态（ErrorState），不解析 message。
 * - 验证码冷却：成功后按服务端默认 60s 起算；命中 429 时以服务端 retryAfterSec 为准（权威）。
 * - accessToken 存 sessionStorage；refreshToken 在 HttpOnly Cookie，JS 不触碰。
 *
 * 「未登录访问 auth 页 → /login?returnTo=」的全局重定向由服务端 401 的 loginUrl +
 * ui.loginTarget 在查询/错误边界产出（协调者接线）；本页负责消费 returnTo 并回跳。
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { ApiError } from '@knowstudio/contracts';
import type { RecoveryAction } from '@knowstudio/ui';
import { AuthRequestError } from './auth-client';
import type { LoginMethod } from './auth-client';
import { useAuthClient } from './auth-context';
import { saveAccessToken } from './auth-session';
import {
  inferChannel,
  parseReturnTo,
  safeRedirectTarget,
  validateLoginInput,
} from './login-logic';
import type { LoginFieldIssue } from './login-logic';
import { LoginView } from './LoginView';

/** 发码成功后的客户端冷却起算值，与 API 端 DEFAULT_CODE_RESEND_COOLDOWN_SEC 一致。 */
const DEFAULT_CODE_COOLDOWN_SEC = 60;

export default function LoginPage() {
  const client = useAuthClient();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const returnTo = parseReturnTo(searchParams.toString());

  const [method, setMethod] = useState<LoginMethod>('password');
  const [account, setAccount] = useState('');
  const [credential, setCredential] = useState('');
  const [pending, setPending] = useState(false);
  const [sendingCode, setSendingCode] = useState(false);
  const [codeCooldownSec, setCodeCooldownSec] = useState(0);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [fieldIssues, setFieldIssues] = useState<readonly LoginFieldIssue[]>([]);
  const [devCode, setDevCode] = useState<string | null>(null);

  // 冷却倒计时：每秒递减，归零即停。SSR 不跑 effect，首帧不受影响。
  useEffect(() => {
    if (codeCooldownSec <= 0) return;
    const timer = setTimeout(() => setCodeCooldownSec((s) => Math.max(0, s - 1)), 1000);
    return () => clearTimeout(timer);
  }, [codeCooldownSec]);

  const handleSubmit = useCallback(async () => {
    const validation = validateLoginInput(account, credential, method);
    if (!validation.ok) {
      setFieldIssues(validation.issues);
      return;
    }
    setFieldIssues([]);
    setError(null);
    setNotice(null);
    setPending(true);
    try {
      const pair = await client.login(validation.data);
      saveAccessToken(pair.accessToken);
      navigate(safeRedirectTarget(returnTo), { replace: true });
    } catch (err) {
      if (err instanceof AuthRequestError && err.apiError != null) {
        setError(err.apiError);
      } else if (err instanceof AuthRequestError) {
        setNotice('网络异常或服务暂时不可用，请稍后重试。');
      } else {
        setNotice('登录时发生未知错误，请稍后重试。');
      }
    } finally {
      setPending(false);
    }
  }, [account, credential, method, client, navigate, returnTo]);

  const handleSendCode = useCallback(async () => {
    const trimmed = account.trim();
    if (trimmed.length === 0) {
      setFieldIssues([{ path: 'account', message: '请先填写手机号或邮箱' }]);
      return;
    }
    setFieldIssues([]);
    setError(null);
    setNotice(null);
    setDevCode(null);
    setSendingCode(true);
    try {
      const result = await client.sendCode(trimmed, inferChannel(trimmed));
      if (result.devCode !== undefined) setDevCode(result.devCode);
      setCodeCooldownSec(DEFAULT_CODE_COOLDOWN_SEC);
    } catch (err) {
      if (err instanceof AuthRequestError && err.apiError != null) {
        setError(err.apiError);
        // 429 的 retryAfterSec 是服务端权威冷却，覆盖客户端起算值。
        if (err.apiError.code === 'RATE_LIMITED') {
          setCodeCooldownSec(err.apiError.details.retryAfterSec);
        }
      } else if (err instanceof AuthRequestError) {
        setNotice('验证码发送失败，请稍后重试。');
      } else {
        setNotice('验证码发送时发生未知错误，请稍后重试。');
      }
    } finally {
      setSendingCode(false);
    }
  }, [account, client]);

  const handleRecovery = useCallback(
    (action: RecoveryAction) => {
      if (action.kind === 'retry') {
        void handleSubmit();
        return;
      }
      if (action.kind === 'navigate') {
        navigate(safeRedirectTarget(action.to));
      }
      // relogin：已身处登录页，冗余动作，忽略。其余恢复动作在登录语境无意义。
    },
    [handleSubmit, navigate],
  );

  return (
    <LoginView
      method={method}
      onMethodChange={setMethod}
      account={account}
      onAccountChange={setAccount}
      credential={credential}
      onCredentialChange={setCredential}
      onSubmit={() => void handleSubmit()}
      onSendCode={() => void handleSendCode()}
      pending={pending}
      sendingCode={sendingCode}
      codeCooldownSec={codeCooldownSec}
      error={error}
      notice={notice}
      returnTo={returnTo}
      fieldIssues={fieldIssues}
      devCode={devCode}
      onDevCodeClose={() => setDevCode(null)}
      onRecovery={handleRecovery}
    />
  );
}
