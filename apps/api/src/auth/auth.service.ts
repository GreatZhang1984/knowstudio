/**
 * 认证核心服务（SPEC §3.13 / arch §1.2 第 18 行 / §13）。
 *  - 手机号/邮箱 + 验证码或密码登录；错误态明确。
 *  - accessToken 15min（JWT）；refreshToken HttpOnly + SameSite=Lax + 轮换 + 服务端可吊销。
 *  - 会话存 Redis（SESSION_STORE），绝不新建数据库会话表。
 *
 * 所有注入参数显式 @Inject(TOKEN)：esbuild 不实现 emitDecoratorMetadata，
 * 靠构造参数类型自动注入会运行时 undefined（假绿）。已用 di-probe 实证。
 */
import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { MeResponse } from '@knowstudio/contracts';
import { SESSION_STORE } from '../shared/tokens.js';
import { AUTH_OPTIONS, CODE_SENDER, USER_STORE } from './auth.tokens.js';
import type { AuthOptions } from '../config/env.js';
import { AuthFailure } from './auth.errors.js';
import type { CodeChannel, CodeSender } from './code-sender.js';
import { verifyPassword } from './password.js';
import {
  hashRefreshSecret,
  issueRefreshToken,
  newCsrfToken,
  newSessionId,
  parseRefreshToken,
} from './refresh-token.js';
import type { SessionStore } from './session-store.js';
import type { UserRecord, UserStore } from './user-store.js';
import { VerificationCodeStore } from './verification-code.store.js';

export interface LoginInput {
  readonly account: string;
  readonly credential: string;
  readonly method: 'password' | 'code';
}

/** 登录/刷新成功产物。controller 负责把 refreshToken/csrfToken 写进 cookie。 */
export interface AuthResult {
  readonly accessToken: string;
  readonly expiresInSec: number;
  readonly userId: string;
  readonly refreshToken: string;
  readonly csrfToken: string;
}

export interface AccessTokenClaims {
  readonly sub: string;
  readonly sid: string;
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(USER_STORE) private readonly users: UserStore,
    @Inject(SESSION_STORE) private readonly sessions: SessionStore,
    @Inject(JwtService) private readonly jwt: JwtService,
    @Inject(AUTH_OPTIONS) private readonly options: AuthOptions,
    @Inject(VerificationCodeStore) private readonly codes: VerificationCodeStore,
    @Inject(CODE_SENDER) private readonly sender: CodeSender,
  ) {}

  async login(input: LoginInput): Promise<AuthResult> {
    const user = await this.users.findByAccount(input.account);
    if (user === null) {
      throw new AuthFailure('INVALID_CREDENTIALS');
    }
    if (input.method === 'password') {
      if (user.passwordHash === null || !(await verifyPassword(user.passwordHash, input.credential))) {
        throw new AuthFailure('INVALID_CREDENTIALS');
      }
    } else {
      const ok = await this.codes.verify(input.account, input.credential);
      if (!ok) {
        throw new AuthFailure('INVALID_CREDENTIALS');
      }
    }
    return this.issueSession(user.id);
  }

  /** 发送登录验证码。冷却期内 VerificationCodeStore 抛 CodeRateLimitedError，由 controller 映射 429。 */
  async sendCode(account: string, channel: CodeChannel): Promise<void> {
    const code = await this.codes.issue(account);
    await this.sender.send(account, code, channel);
  }

  /**
   * 刷新：double-submit CSRF 校验 + 原子轮换 + 重放检测。
   * csrfHeader 必须等于 csrfCookie 且等于会话内 csrfToken（arch §13）。
   */
  async refresh(refreshToken: string, csrfHeader: string, csrfCookie: string): Promise<AuthResult> {
    const parts = parseRefreshToken(refreshToken);
    if (parts === null) {
      throw new AuthFailure('UNAUTHENTICATED');
    }
    const session = await this.sessions.find(parts.sessionId);
    if (session === null || session.revoked) {
      throw new AuthFailure('UNAUTHENTICATED');
    }
    if (csrfHeader.length === 0 || csrfHeader !== csrfCookie || csrfHeader !== session.csrfToken) {
      throw new AuthFailure('UNAUTHENTICATED');
    }
    const next = issueRefreshToken(parts.sessionId);
    const nextCsrf = newCsrfToken();
    const result = await this.sessions.rotate(
      parts.sessionId,
      hashRefreshSecret(parts.secret),
      next.hash,
      nextCsrf,
      this.options.refreshTtlSec,
    );
    if (!result.ok) {
      // REPLAY / REVOKED / NO_SESSION / INVALID 一律拒绝；重放已在 store 内吊销会话。
      throw new AuthFailure('UNAUTHENTICATED');
    }
    const accessToken = this.signAccessToken(result.userId, result.sessionId);
    return {
      accessToken,
      expiresInSec: this.options.accessTokenTtlSec,
      userId: result.userId,
      refreshToken: next.token,
      csrfToken: nextCsrf,
    };
  }

  /** 登出 / 吊销：服务端会话立即失效，旧 accessToken 与旧 refreshToken 都被拒。 */
  async logout(sessionId: string): Promise<void> {
    await this.sessions.revoke(sessionId);
  }

  async me(userId: string): Promise<ReturnType<typeof MeResponse.parse>> {
    const user = await this.users.findById(userId);
    if (user === null) {
      throw new AuthFailure('UNAUTHENTICATED');
    }
    return MeResponse.parse({
      id: user.id,
      name: user.name,
      avatarUrl: user.avatarUrl,
      domainPrefs: [...user.domainPrefs],
      defaultPlatforms: [...user.defaultPlatforms],
      planId: user.planId,
      theme: user.theme,
      onboardedAt: user.onboardedAt,
      createdAt: user.createdAt,
    });
  }

  /** 校验 accessToken 并确认会话未吊销，返回主体。AuthGuard 复用。 */
  async resolvePrincipal(accessToken: string): Promise<AccessTokenClaims | null> {
    let claims: AccessTokenClaims;
    try {
      claims = this.jwt.verify<AccessTokenClaims>(accessToken);
    } catch {
      return null;
    }
    if (typeof claims.sub !== 'string' || typeof claims.sid !== 'string') {
      return null;
    }
    const session = await this.sessions.find(claims.sid);
    if (session === null || session.revoked || session.userId !== claims.sub) {
      return null;
    }
    return claims;
  }

  private async issueSession(userId: string): Promise<AuthResult> {
    const sessionId = newSessionId();
    const refresh = issueRefreshToken(sessionId);
    const csrfToken = newCsrfToken();
    await this.sessions.create({
      userId,
      sessionId,
      refreshHash: refresh.hash,
      csrfToken,
      ttlSec: this.options.refreshTtlSec,
    });
    const accessToken = this.signAccessToken(userId, sessionId);
    return {
      accessToken,
      expiresInSec: this.options.accessTokenTtlSec,
      userId,
      refreshToken: refresh.token,
      csrfToken,
    };
  }

  private signAccessToken(userId: string, sessionId: string): string {
    return this.jwt.sign({ sub: userId, sid: sessionId }, { expiresIn: `${this.options.accessTokenTtlSec}s` });
  }
}

/** 供 controller 把 UserRecord 暴露给 /me 时复用（当前 me 已在 service 内完成）。 */
export type { UserRecord };