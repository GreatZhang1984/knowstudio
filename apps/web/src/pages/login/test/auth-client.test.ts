import { describe, expect, it } from 'vitest';
import { MeResponse } from '@knowstudio/contracts';
import { AuthRequestError, createAuthClient } from '../auth-client';
import type { HttpClient } from '../auth-client';

/**
 * auth 数据缝隙实测（T-06）。注入假 transport，确定性驱动成功/失败/限流/断网分支，
 * 不碰真实网络。断言请求形状（method/path/body/credentials/头）与契约解析结果。
 *
 * recorder 每次调用都新建 Response：Response body 只能读一次，复用同一对象会让
 * 第二次 res.json() 抛「body already read」，把错误信封吞成 null（已踩坑修正）。
 */
interface Call {
  input: string;
  init?: RequestInit;
}

function recorder(make: () => Response): { http: HttpClient; calls: Call[] } {
  const calls: Call[] = [];
  const http: HttpClient = async (input, init) => {
    calls.push({ input, init });
    return make();
  };
  return { http, calls };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const TOKEN_PAIR = { accessToken: 'access.jwt.token', expiresInSec: 900, userId: 'u1' };

const ME = {
  id: 'u1',
  name: '创作者',
  avatarUrl: null,
  domainPrefs: ['职场技能'],
  defaultPlatforms: ['douyin'],
  planId: 'free',
  theme: 'dark',
  onboardedAt: null,
  createdAt: '2026-11-13T00:00:00Z',
};

function bodyOf(call: Call): Record<string, unknown> {
  return JSON.parse(String(call.init?.body)) as Record<string, unknown>;
}

function headerOf(call: Call, name: string): string | undefined {
  const headers = call.init?.headers as Record<string, string> | undefined;
  return headers?.[name];
}

describe('createAuthClient.login', () => {
  it('成功 → POST /api/auth/login，携带 credentials，返回契约 TokenPair', async () => {
    const { http, calls } = recorder(() => json(TOKEN_PAIR));
    const client = createAuthClient(http);
    const pair = await client.login({ account: '13800000000', credential: 'secret', method: 'password' });
    expect(pair).toEqual(TOKEN_PAIR);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe('/api/auth/login');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.credentials).toBe('include');
    expect(bodyOf(calls[0]!)).toEqual({ account: '13800000000', credential: 'secret', method: 'password' });
  });

  it('401 UNAUTHENTICATED → AuthRequestError 携带已校验契约信封（按 code 分支）', async () => {
    const { http } = recorder(() =>
      json({ code: 'UNAUTHENTICATED', message: '未认证或凭证无效', details: { loginUrl: '/login' } }, 401),
    );
    const client = createAuthClient(http);
    try {
      await client.login({ account: '13800000000', credential: 'wrong', method: 'password' });
      throw new Error('应当抛出');
    } catch (err) {
      expect(err).toBeInstanceOf(AuthRequestError);
      const e = err as AuthRequestError;
      expect(e.status).toBe(401);
      expect(e.apiError?.code).toBe('UNAUTHENTICATED');
      if (e.apiError?.code === 'UNAUTHENTICATED') expect(e.apiError.details.loginUrl).toBe('/login');
    }
  });

  it('服务端 400 VALIDATION_FAILED → details.fields 原样解析（请求体客户端合法，模拟服务端拒绝）', async () => {
    const { http } = recorder(() =>
      json(
        { code: 'VALIDATION_FAILED', message: '参数校验失败', details: { fields: [{ path: 'account', message: '必填' }] } },
        400,
      ),
    );
    const client = createAuthClient(http);
    try {
      await client.login({ account: '13800000000', credential: 'x', method: 'password' });
      throw new Error('应当抛出');
    } catch (err) {
      const e = err as AuthRequestError;
      expect(e.status).toBe(400);
      expect(e.apiError?.code).toBe('VALIDATION_FAILED');
      if (e.apiError?.code === 'VALIDATION_FAILED') expect(e.apiError.details.fields).toHaveLength(1);
    }
  });

  it('请求体先经契约 LoginRequest 校验：非法 method 在发送前即抛', async () => {
    const { http, calls } = recorder(() => json(TOKEN_PAIR));
    const client = createAuthClient(http);
    await expect(
      client.login({ account: 'a', credential: 'b', method: 'bad' as never }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe('createAuthClient.sendCode', () => {
  it('202 → 受理，body 带 account 与推断 channel', async () => {
    const { http, calls } = recorder(() => json({ accepted: true }, 202));
    const client = createAuthClient(http);
    await expect(client.sendCode('user@example.com', 'email')).resolves.toBeUndefined();
    expect(calls[0]?.input).toBe('/api/auth/code');
    expect(bodyOf(calls[0]!)).toEqual({ account: 'user@example.com', channel: 'email' });
  });

  it('缺省 channel 时不写该键（交服务端推断）', async () => {
    const { http, calls } = recorder(() => json({ accepted: true }, 202));
    const client = createAuthClient(http);
    await client.sendCode('13800000000');
    expect(bodyOf(calls[0]!)).toEqual({ account: '13800000000' });
  });

  it('429 RATE_LIMITED → retryAfterSec 权威冷却', async () => {
    const { http } = recorder(() =>
      json({ code: 'RATE_LIMITED', message: '请求过于频繁', details: { retryAfterSec: 42 } }, 429),
    );
    const client = createAuthClient(http);
    try {
      await client.sendCode('13800000000');
      throw new Error('应当抛出');
    } catch (err) {
      const e = err as AuthRequestError;
      expect(e.status).toBe(429);
      expect(e.apiError?.code).toBe('RATE_LIMITED');
      if (e.apiError?.code === 'RATE_LIMITED') expect(e.apiError.details.retryAfterSec).toBe(42);
    }
  });
});

describe('createAuthClient.refresh / logout / me', () => {
  it('refresh 带 X-CSRF-Token 头与 credentials（double-submit）', async () => {
    const { http, calls } = recorder(() => json(TOKEN_PAIR));
    const client = createAuthClient(http);
    const pair = await client.refresh('csrf-abc');
    expect(pair).toEqual(TOKEN_PAIR);
    expect(calls[0]?.input).toBe('/api/auth/refresh');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.credentials).toBe('include');
    expect(headerOf(calls[0]!, 'X-CSRF-Token')).toBe('csrf-abc');
  });

  it('logout 带 Bearer，204 → void', async () => {
    const { http, calls } = recorder(() => new Response(null, { status: 204 }));
    const client = createAuthClient(http);
    await expect(client.logout('access.jwt.token')).resolves.toBeUndefined();
    expect(calls[0]?.input).toBe('/api/auth/logout');
    expect(headerOf(calls[0]!, 'Authorization')).toBe('Bearer access.jwt.token');
  });

  it('me 带 Bearer，GET，返回契约 MeResponse', async () => {
    const { http, calls } = recorder(() => json(ME));
    const client = createAuthClient(http);
    const me = await client.me('access.jwt.token');
    expect(me).toEqual(MeResponse.parse(ME));
    expect(calls[0]?.input).toBe('/api/me');
    expect(calls[0]?.init?.method).toBe('GET');
    expect(headerOf(calls[0]!, 'Authorization')).toBe('Bearer access.jwt.token');
  });
});

describe('createAuthClient · 非契约失败归一', () => {
  it('transport reject（断网）→ status 0 / apiError null', async () => {
    const http: HttpClient = async () => {
      throw new Error('network down');
    };
    const client = createAuthClient(http);
    try {
      await client.login({ account: 'a', credential: 'b', method: 'password' });
      throw new Error('应当抛出');
    } catch (err) {
      const e = err as AuthRequestError;
      expect(e).toBeInstanceOf(AuthRequestError);
      expect(e.status).toBe(0);
      expect(e.apiError).toBeNull();
    }
  });

  it('5xx 非契约体 → apiError null（视图走兜底文案，不硬解析 message）', async () => {
    const { http } = recorder(() => new Response('Internal Server Error', { status: 500 }));
    const client = createAuthClient(http);
    try {
      await client.me('t');
      throw new Error('应当抛出');
    } catch (err) {
      const e = err as AuthRequestError;
      expect(e.status).toBe(500);
      expect(e.apiError).toBeNull();
    }
  });
});