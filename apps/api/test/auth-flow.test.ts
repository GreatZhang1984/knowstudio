/**
 * 认证 HTTP 流程集成测试：真实 Nest 应用（listen(0)）+ 真实 Redis 7 + 真实 fetch。
 * 覆盖 SPEC §3.13：登录成功/失败错误态、验证码登录与限频、/me、未登录 401+loginUrl。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { CODE_SENDER } from '../src/auth/auth.tokens.js';
import type { LocalDevCodeSender } from '../src/auth/code-sender.js';
import { createTestApp, makeUser, cookiesFrom, type TestApp } from './helpers/app.js';

/** 随机唯一手机号：验证码冷却/码键按 account 存 Redis（TTL 60s/300s），
 *  固定账号会在 TTL 内跨运行污染，故每次运行用唯一账号。 */
function uniquePhone(): string {
  return `138${randomBytes(4).readUInt32BE(0) % 100_000_000}`.padEnd(11, '0').slice(0, 11);
}

describe('认证 HTTP 流程 · 真实 Nest + 真实 Redis', () => {
  let t: TestApp;
  const PHONE = '13800000001';

  beforeAll(async () => {
    const user = await makeUser({ id: 'u_alice', phone: PHONE, password: 'alice-pass' });
    t = await createTestApp({ users: [user] });
  });
  afterAll(async () => {
    await t.close();
  });

  async function login(body: unknown): Promise<Response> {
    return fetch(`${t.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('密码登录成功 → 200 TokenPair（expiresInSec=900）+ HttpOnly/SameSite=Lax refresh cookie', async () => {
    const res = await login({ account: PHONE, credential: 'alice-pass', method: 'password' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { accessToken: string; expiresInSec: number; userId: string };
    expect(body.accessToken.length).toBeGreaterThan(0);
    expect(body.expiresInSec).toBe(900);
    expect(body.userId).toBe('u_alice');
    const cookies = cookiesFrom(res);
    expect(cookies['ks_refresh']).toBeTruthy();
    expect(cookies['ks_csrf']).toBeTruthy();
    const refreshLine = (res.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('ks_refresh='));
    expect(refreshLine).toContain('HttpOnly');
    expect(refreshLine).toContain('SameSite=Lax');
    const csrfLine = (res.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('ks_csrf='));
    expect(csrfLine).not.toContain('HttpOnly'); // CSRF cookie 需 JS 可读（double-submit）
  });

  it('密码错误 → 401 UNAUTHENTICATED + details.loginUrl', async () => {
    const res = await login({ account: PHONE, credential: 'wrong', method: 'password' });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string; details: { loginUrl: string } };
    expect(body.code).toBe('UNAUTHENTICATED');
    expect(body.details.loginUrl).toBe('/login');
  });

  it('账号不存在 → 401（不泄露账号是否存在）', async () => {
    const res = await login({ account: '13900000000', credential: 'x', method: 'password' });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe('UNAUTHENTICATED');
  });

  it('请求体非法 → 400 VALIDATION_FAILED + fields', async () => {
    const res = await login({ account: PHONE }); // 缺 credential/method
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; details: { fields: unknown[] } };
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(Array.isArray(body.details.fields)).toBe(true);
  });

  it('验证码登录：发送→取回→登录成功；冷却内重发 → 429 RATE_LIMITED', async () => {
    const account = uniquePhone();
    await t.userStore.seed(await makeUser({ id: `u_code_${account}`, phone: account }));
    const sendRes = await fetch(`${t.baseUrl}/api/auth/code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account }),
    });
    expect(sendRes.status).toBe(202);
    const sender = t.app.get<LocalDevCodeSender>(CODE_SENDER);
    const code = sender.peek(account)?.code;
    expect(code).toMatch(/^\d{6}$/);

    const loginRes = await login({ account, credential: code, method: 'code' });
    expect(loginRes.status).toBe(200);
    expect(((await loginRes.json()) as { userId: string }).userId).toBe(`u_code_${account}`);

    // 冷却内重发 → 429
    const again = await fetch(`${t.baseUrl}/api/auth/code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account }),
    });
    expect(again.status).toBe(429);
    const body = (await again.json()) as { code: string; details: { retryAfterSec: number } };
    expect(body.code).toBe('RATE_LIMITED');
    expect(body.details.retryAfterSec).toBeGreaterThan(0);
  });

  it('错误验证码 → 401', async () => {
    const account = uniquePhone();
    await t.userStore.seed(await makeUser({ id: `u_code2_${account}`, phone: account }));
    await fetch(`${t.baseUrl}/api/auth/code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account }),
    });
    const res = await login({ account, credential: '000000', method: 'code' });
    expect(res.status).toBe(401);
  });

  it('/me：带有效 Bearer → 200 MeResponse；无 token → 401 + loginUrl（未登录重定向依据）', async () => {
    const loginRes = await login({ account: PHONE, credential: 'alice-pass', method: 'password' });
    const { accessToken } = (await loginRes.json()) as { accessToken: string };

    const meRes = await fetch(`${t.baseUrl}/api/me`, { headers: { authorization: `Bearer ${accessToken}` } });
    expect(meRes.status).toBe(200);
    const me = (await meRes.json()) as { id: string; name: string; defaultPlatforms: string[] };
    expect(me.id).toBe('u_alice');
    expect(me.defaultPlatforms).toContain('douyin');

    const noAuth = await fetch(`${t.baseUrl}/api/me`);
    expect(noAuth.status).toBe(401);
    const body = (await noAuth.json()) as { code: string; details: { loginUrl: string } };
    expect(body.code).toBe('UNAUTHENTICATED');
    expect(body.details.loginUrl).toBe('/login');
  });

  it('伪造/篡改 accessToken → 401', async () => {
    const res = await fetch(`${t.baseUrl}/api/me`, { headers: { authorization: 'Bearer forged.token.here' } });
    expect(res.status).toBe(401);
  });
});