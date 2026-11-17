/**
 * auth 缝隙的组合根（T-06）。把浏览器全局 fetch 绑成 transport 注入 createAuthClient，
 * 并以 React Context 暴露，协调者接线时可用 <AuthClientProvider> 覆盖默认 transport
 * （例如换成带统一 401 拦截 / Bearer 续期的实现），单测注入假 http。
 *
 * 设计说明：本目录所有网络访问都收在 createAuthClient(http) 缝隙后，http 是一等参数。
 * 这里只做「绑定全局 transport」这一件组合根的事，不在组件里散落 fetch 调用——
 * 与 work/api.ts 把数据访问收在缝隙后是同一架构纪律（noLocalGates 静态防线）。
 */
import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import { createAuthClient } from './auth-client';
import type { AuthClient, HttpClient } from './auth-client';

const defaultTransport: HttpClient =
  typeof globalThis.fetch === 'function'
    ? globalThis.fetch.bind(globalThis)
    : () => Promise.reject(new Error('当前环境没有可用的 fetch transport'));

/** 默认客户端：绑定全局 fetch。协调者未显式注入时，登录页用它即可工作。 */
export const defaultAuthClient: AuthClient = createAuthClient(defaultTransport);

const AuthClientContext = createContext<AuthClient>(defaultAuthClient);

export function AuthClientProvider({
  client,
  children,
}: {
  client: AuthClient;
  children: ReactNode;
}) {
  return <AuthClientContext.Provider value={client}>{children}</AuthClientContext.Provider>;
}

export function useAuthClient(): AuthClient {
  return useContext(AuthClientContext);
}