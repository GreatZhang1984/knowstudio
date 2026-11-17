/**
 * 认证路由（SPEC §5 spec:563 / arch §10.1）。
 *  POST /api/auth/login   手机号/邮箱 + 验证码或密码
 *  POST /api/auth/code    发送登录验证码 [待确认] SPEC 未定义发送端点与供应商，路径为工程决定
 *  POST /api/auth/refresh HttpOnly Cookie 轮换（arch §10.1）
 *  POST /api/auth/logout  吊销会话
 *  GET  /api/me           当前用户（MeResponse）
 *
 * 契约复用 @knowstudio/contracts：LoginRequest / TokenPair / MeResponse。
 * 验证码发送与登出无契约 schema → 报告 [待确认]，不自发明 DTO。
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { LoginRequest, TokenPair } from '@knowstudio/contracts';
import { REQUEST_PRINCIPAL_KEY, type AuthPrincipal } from '../shared/auth-principal.js';
import { AUTH_OPTIONS } from './auth.tokens.js';
import type { AuthOptions } from '../config/env.js';
import { AuthFailure } from './auth.errors.js';
import { AuthGuard } from './auth.guard.js';
import { AuthService, type AuthResult } from './auth.service.js';
import type { CodeChannel } from './code-sender.js';

const REFRESH_COOKIE = 'ks_refresh';
const CSRF_COOKIE = 'ks_csrf';
const REFRESH_COOKIE_PATH = '/api/auth';
const CSRF_COOKIE_PATH = '/';

interface CookieResponse {
  cookie(name: string, value: string, options: Record<string, unknown>): void;
  clearCookie(name: string, options: Record<string, unknown>): void;
}

interface CookieRequest {
  headers: Record<string, string | string[] | undefined>;
}

function parseCookies(header: string | string[] | undefined): Record<string, string> {
  const value = Array.isArray(header) ? header[0] : header;
  const out: Record<string, string> = {};
  if (typeof value !== 'string') return out;
  for (const part of value.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (name.length > 0) out[name] = decodeURIComponent(val);
  }
  return out;
}

function headerValue(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  return typeof value === 'string' ? value : '';
}

@Controller()
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(AUTH_OPTIONS) private readonly options: AuthOptions,
  ) {}

  @Post('auth/login')
  @HttpCode(200)
  async login(
    @Body() body: unknown,
    @Res({ passthrough: true }) res: CookieResponse,
  ): Promise<ReturnType<typeof TokenPair.parse>> {
    const parsed = LoginRequest.safeParse(body);
    if (!parsed.success) {
      throw new AuthFailure('VALIDATION_FAILED', {
        fields: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const result = await this.auth.login(parsed.data);
    this.writeAuthCookies(res, result);
    return TokenPair.parse({
      accessToken: result.accessToken,
      expiresInSec: result.expiresInSec,
      userId: result.userId,
    });
  }

  /**
   * [待确认] SPEC 未定义验证码发送端点/供应商/模板。本端点为工程必需（验证码登录的前置），
   * 路径与请求形状是工程决定，已在报告披露。channel 缺省按 account 形状推断。
   */
  @Post('auth/code')
  @HttpCode(202)
  async sendCode(@Body() body: unknown): Promise<{ accepted: true }> {
    const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    const account = record['account'];
    if (typeof account !== 'string' || account.length === 0 || account.length > 255) {
      throw new AuthFailure('VALIDATION_FAILED', {
        fields: [{ path: 'account', message: 'account 必须是非空字符串（手机号或邮箱）' }],
      });
    }
    const rawChannel = record['channel'];
    let channel: CodeChannel;
    if (rawChannel === 'sms' || rawChannel === 'email') {
      channel = rawChannel;
    } else if (rawChannel === undefined) {
      channel = account.includes('@') ? 'email' : 'sms';
    } else {
      throw new AuthFailure('VALIDATION_FAILED', {
        fields: [{ path: 'channel', message: 'channel 只能是 sms 或 email' }],
      });
    }
    await this.auth.sendCode(account, channel);
    return { accepted: true };
  }

  @Post('auth/refresh')
  @HttpCode(200)
  async refresh(
    @Req() req: CookieRequest,
    @Res({ passthrough: true }) res: CookieResponse,
  ): Promise<ReturnType<typeof TokenPair.parse>> {
    const cookies = parseCookies(req.headers['cookie']);
    const refreshToken = cookies[REFRESH_COOKIE] ?? '';
    const csrfCookie = cookies[CSRF_COOKIE] ?? '';
    const csrfHeader = headerValue(req.headers['x-csrf-token']);
    if (refreshToken.length === 0) {
      throw new AuthFailure('UNAUTHENTICATED');
    }
    const result = await this.auth.refresh(refreshToken, csrfHeader, csrfCookie);
    this.writeAuthCookies(res, result);
    return TokenPair.parse({
      accessToken: result.accessToken,
      expiresInSec: result.expiresInSec,
      userId: result.userId,
    });
  }

  @Post('auth/logout')
  @UseGuards(AuthGuard)
  @HttpCode(204)
  async logout(
    @Req() req: CookieRequest & Record<string, unknown>,
    @Res({ passthrough: true }) res: CookieResponse,
  ): Promise<void> {
    const principal = req[REQUEST_PRINCIPAL_KEY] as AuthPrincipal | undefined;
    if (principal !== undefined) {
      await this.auth.logout(principal.sessionId);
    }
    this.clearAuthCookies(res);
  }

  @Get('me')
  @UseGuards(AuthGuard)
  async me(@Req() req: CookieRequest & Record<string, unknown>): Promise<unknown> {
    const principal = req[REQUEST_PRINCIPAL_KEY] as AuthPrincipal | undefined;
    if (principal === undefined) {
      throw new AuthFailure('UNAUTHENTICATED');
    }
    return this.auth.me(principal.userId);
  }

  private writeAuthCookies(res: CookieResponse, result: AuthResult): void {
    const maxAge = this.options.refreshTtlSec * 1000;
    const base = {
      sameSite: 'lax' as const,
      secure: this.options.cookieSecure,
      ...(this.options.cookieDomain !== undefined ? { domain: this.options.cookieDomain } : {}),
    };
    res.cookie(REFRESH_COOKIE, result.refreshToken, {
      ...base,
      httpOnly: true,
      path: REFRESH_COOKIE_PATH,
      maxAge,
    });
    // CSRF cookie 非 HttpOnly：前端 JS 需读取它做 double-submit（arch §13）。
    res.cookie(CSRF_COOKIE, result.csrfToken, {
      ...base,
      httpOnly: false,
      path: CSRF_COOKIE_PATH,
      maxAge,
    });
  }

  private clearAuthCookies(res: CookieResponse): void {
    const base = {
      sameSite: 'lax' as const,
      secure: this.options.cookieSecure,
      ...(this.options.cookieDomain !== undefined ? { domain: this.options.cookieDomain } : {}),
    };
    res.clearCookie(REFRESH_COOKIE, { ...base, httpOnly: true, path: REFRESH_COOKIE_PATH });
    res.clearCookie(CSRF_COOKIE, { ...base, httpOnly: false, path: CSRF_COOKIE_PATH });
  }
}