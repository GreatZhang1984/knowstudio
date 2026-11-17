/**
 * 认证数据访问缝隙（T-06 / SPEC §3.13）。
 *
 * 架构纪律：所有 auth 网络访问收在 `createAuthClient(http)` 这一层缝隙后面，
 * transport（fetch 兼容函数）作为**一等参数注入**，而不是在组件里散落 fetch 调用。
 * 这样 T-06 落地真实 /api/auth 时只换 transport 绑定，逻辑与视图不动；单测注入假 http
 * 即可确定性驱动成功/失败/限流分支，不碰真实网络。
 *
 * 契约复用 @knowstudio/contracts：LoginRequest / TokenPair / MeResponse / ApiErrorSchema。
 * 错误一律解析成契约 ApiError 信封后按 code 分支（架构 §10.2），绝不解析 message。
 *
 * 本文件零 IO 副作用、不引用全局 fetch、不碰 DOM，故可在 node 环境直接单测。
 */
import { ApiErrorSchema, LoginRequest, MeResponse, TokenPair } from '@knowstudio/contracts';
import type { ApiError, Me } from '@knowstudio/contracts';

/** 登录请求体（契约 LoginRequest 的输出形状）。 */
export type LoginInput = ReturnType<typeof LoginRequest.parse>;
/** 登录/刷新成功产物（契约 TokenPair：accessToken + expiresInSec + userId）。 */
export type TokenPairData = ReturnType<typeof TokenPair.parse>;
/** 验证码渠道。与 API 端 CodeChannel 对齐（sms / email）。 */
export type CodeChannel = 'sms' | 'email';
/** 登录方式。 */
export type LoginMethod = LoginInput['method'];

/** fetch 兼容的 transport。组合根注入 globalThis.fetch；单测注入假实现。 */
export type HttpClient = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * 结构化请求失败。携带 HTTP 状态与**已校验的契约错误信封**（解析不出则为 null，
 * 例如断网 / 5xx 非契约体 / 响应不是 JSON）。视图按 apiError.code 分支，status 仅作兜底。
 */
export class AuthRequestError extends Error {
  constructor(
    readonly status: number,
    readonly apiError: ApiError | null,
  ) {
    super(apiError?.code ?? `HTTP_${status}`);
    this.name = 'AuthRequestError';
  }
}

export interface AuthClient {
  /** 手机号/邮箱 + 验证码或密码登录。成功返回 TokenPair；refresh/csrf 由服务端写 HttpOnly Cookie。 */
  login(req: LoginInput): Promise<TokenPairData>;
  /** 发送登录验证码。202 受理；冷却期内服务端回 429 RATE_LIMITED。 */
  sendCode(account: string, channel?: CodeChannel): Promise<void>;
  /** 轮换刷新。csrfToken 由调用方从 ks_csrf cookie 读出做 double-submit（arch §13）。 */
  refresh(csrfToken: string): Promise<TokenPairData>;
  /** 吊销会话。需要 Bearer accessToken；服务端立即失效旧 refresh 与旧 access。 */
  logout(accessToken: string): Promise<void>;
  /** 当前用户。需要 Bearer accessToken。 */
  me(accessToken: string): Promise<Me>;
}

const JSON_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json' } as const;

/**
 * 统一发送：成功返回解析后的 JSON（204 返回 null）；失败抛 AuthRequestError。
 * 网络异常（transport reject）归一为 status=0 / apiError=null，视图据此渲染「断网」兜底态。
 */
async function send(http: HttpClient, input: string, init: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await http(input, init);
  } catch {
    throw new AuthRequestError(0, null);
  }
  if (res.ok) {
    if (res.status === 204) return null;
    return (await res.json()) as unknown;
  }
  let apiError: ApiError | null = null;
  try {
    const parsed = ApiErrorSchema.safeParse((await res.json()) as unknown);
    if (parsed.success) apiError = parsed.data;
  } catch {
    // 响应体不是 JSON 或不符合契约：保留 null，视图走非契约兜底文案。
  }
  throw new AuthRequestError(res.status, apiError);
}

/**
 * 用注入的 transport 构建 AuthClient。这是 auth 数据访问的唯一缝隙：
 * 视图与容器只依赖 AuthClient 接口，不知道 fetch 的存在。
 */
export function createAuthClient(http: HttpClient): AuthClient {
  return {
    async login(req) {
      const body = LoginRequest.parse(req);
      const json = await send(http, '/api/auth/login', {
        method: 'POST',
        headers: JSON_HEADERS,
        credentials: 'include',
        body: JSON.stringify(body),
      });
      return TokenPair.parse(json);
    },

    async sendCode(account, channel) {
      const payload: Record<string, unknown> = { account };
      if (channel !== undefined) payload['channel'] = channel;
      await send(http, '/api/auth/code', {
        method: 'POST',
        headers: JSON_HEADERS,
        credentials: 'include',
        body: JSON.stringify(payload),
      });
    },

    async refresh(csrfToken) {
      const json = await send(http, '/api/auth/refresh', {
        method: 'POST',
        headers: { ...JSON_HEADERS, 'X-CSRF-Token': csrfToken },
        credentials: 'include',
      });
      return TokenPair.parse(json);
    },

    async logout(accessToken) {
      await send(http, '/api/auth/logout', {
        method: 'POST',
        headers: { ...JSON_HEADERS, Authorization: `Bearer ${accessToken}` },
        credentials: 'include',
      });
    },

    async me(accessToken) {
      const json = await send(http, '/api/me', {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
        credentials: 'include',
      });
      return MeResponse.parse(json);
    },
  };
}