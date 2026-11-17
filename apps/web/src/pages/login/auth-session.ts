/**
 * 客户端会话产物（T-06 / arch §13）。
 *
 * accessToken 存 sessionStorage（随标签页关闭清除，15min 短寿命）；refreshToken 在
 * HttpOnly Cookie 里，JS 读不到也不该读。ks_csrf 是非 HttpOnly Cookie，前端读出它做
 * double-submit（arch §13）。本模块只搬运这两个客户端可见产物，不做任何鉴权判定。
 *
 * 全部访问带 SSR/node 守卫：无 sessionStorage/document 时退化为 no-op / 空值，不抛异常，
 * 故可在 node 环境直接单测，也不会让 SSR 首帧崩溃。
 */
const ACCESS_TOKEN_KEY = 'knowstudio.accessToken';
const CSRF_COOKIE = 'ks_csrf';

function storage(): Storage | null {
  return typeof sessionStorage === 'undefined' ? null : sessionStorage;
}

export function saveAccessToken(token: string): void {
  storage()?.setItem(ACCESS_TOKEN_KEY, token);
}

export function readAccessToken(): string | null {
  return storage()?.getItem(ACCESS_TOKEN_KEY) ?? null;
}

export function clearAccessToken(): void {
  storage()?.removeItem(ACCESS_TOKEN_KEY);
}

/** 读出 ks_csrf cookie 值用于刷新时的 double-submit 头。无 document/cookie 时返回空串。 */
export function readCsrfCookie(): string {
  if (typeof document === 'undefined') return '';
  const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${CSRF_COOKIE}=([^;]*)`));
  const value = match?.[1];
  return value === undefined ? '' : decodeURIComponent(value);
}