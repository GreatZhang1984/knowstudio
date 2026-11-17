/**
 * 登录页纯逻辑（T-06 / SPEC §3.13）。零 IO、不碰 DOM、不引 React，可在 node 环境直接单测。
 *
 * 三条硬约束：
 * 1. returnTo 只收站内相对路径，复用契约 ReturnToQuery / RelativePath，拒绝 `//evil.com`、
 *    `/\evil.com`、绝对 URL —— 否则深链回跳就是开放重定向钓鱼面（架构 §10.1）。
 * 2. 错误分支只看契约 code，绝不解析 message（架构 §10.2）。
 * 3. 账号/凭证校验复用契约 LoginRequest，不自发明 DTO。
 */
import { LoginRequest, RelativePath, ReturnToQuery } from '@knowstudio/contracts';
import type { ApiError } from '@knowstudio/contracts';
import type { CodeChannel, LoginInput, LoginMethod } from './auth-client';

/** 没有合法 returnTo 时的登录后落点：工作台首页。 */
export const RETURN_TO_FALLBACK = '/';

/** 客户端校验问题项。形状与契约 ValidationFailed.details.fields 一致（path + message）。 */
export interface LoginFieldIssue {
  path: string;
  message: string;
}

export type LoginValidation =
  | { ok: true; data: LoginInput }
  | { ok: false; issues: LoginFieldIssue[] };

/**
 * 从 query string 取 returnTo 并做契约校验。
 * 非法（协议相对 / 绝对 URL / 空串）一律丢弃返回 undefined，绝不把不可信值带进跳转。
 */
export function parseReturnTo(search: string): string | undefined {
  const raw = new URLSearchParams(search).get('returnTo');
  const parsed = ReturnToQuery.safeParse({ returnTo: raw ?? undefined });
  return parsed.success ? parsed.data.returnTo : undefined;
}

/**
 * 登录成功后的跳转目标。对 returnTo 再做一次 RelativePath 校验（纵深防御）：
 * 合法则原样回跳，否则落到工作台首页。调用方不得绕过它直接 navigate(用户输入)。
 */
export function safeRedirectTarget(returnTo: string | undefined, fallback = RETURN_TO_FALLBACK): string {
  if (returnTo === undefined) return fallback;
  const parsed = RelativePath.safeParse(returnTo);
  return parsed.success ? parsed.data : fallback;
}

/** 验证码渠道推断：含 @ 视为邮箱，否则短信。与 API 端 sendCode 的缺省推断一致。 */
export function inferChannel(account: string): CodeChannel {
  return account.includes('@') ? 'email' : 'sms';
}

/** 账号种类，仅用于 UI 标签/占位提示，不参与提交校验（服务端接受任意非空账号）。 */
export function accountKind(account: string): 'email' | 'phone' | 'unknown' {
  const trimmed = account.trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return 'email';
  if (/^1[3-9]\d{9}$/.test(trimmed)) return 'phone';
  return 'unknown';
}

/**
 * 提交前的客户端校验：复用契约 LoginRequest。失败时把 zod issues 映射成字段问题项，
 * 供表单内联展示；成功时返回规范化后的请求体。
 */
export function validateLoginInput(
  account: string,
  credential: string,
  method: LoginMethod,
): LoginValidation {
  const parsed = LoginRequest.safeParse({ account, credential, method });
  if (parsed.success) return { ok: true, data: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  };
}

/**
 * 登录页语境下的错误文案覆盖。只按 code 分支：
 * 服务端把「账号或凭证不正确」映射成 UNAUTHENTICATED 信封，而 ERROR_UI 的通用 401 文案
 * 是「登录状态已过期」（面向会话过期场景）。在登录表单上沿用它会误导用户，故这里给出
 * 登录语境的正确文案；其余码返回 undefined，交回 ERROR_UI 的规范映射（不另抄一份）。
 */
export function loginErrorOverride(error: ApiError): { title: string; description: string } | undefined {
  if (error.code === 'UNAUTHENTICATED') {
    return {
      title: '账号或凭证不正确',
      description: '请检查手机号/邮箱与验证码或密码后重试。验证码登录请先点「发送验证码」。',
    };
  }
  return undefined;
}