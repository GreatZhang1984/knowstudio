/**
 * T-06 硬 DoD 集成证明（plan T-06 / arch §13）：真实 Nest + 真实 Redis 7 + 真实 fetch。
 *  #1 refresh 可吊销：登录后吊销会话 → 旧 refreshToken 立即失效、旧 accessToken 也被拒；
 *     轮换后旧 token 不可重用（重放检测）。
 *  #3 跨用户隔离：用户 A 的 token 拿不到用户 B 的资源 → 404（与 WP11 OwnershipGuard 语义对齐）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, makeUser, cookiesFrom, cookieHeader, type TestApp } from './helpers/app.js';
import { TestResourceController } from './helpers/test-resource.controller.js';

interface LoginBody {
  accessToken: string;
  expiresInSec: number;
  userId: string;
}

async function login(t: TestApp, account: string, credential: string): Promise<{ body: LoginBody; cookies: Record<string, string> }> {
  const res = await fetch(`${t.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account, credential, method: 'password' }),
  });
  expect(res.status).toBe(200);
  return { body: (await res.json()) as LoginBody, cookies: cookiesFrom(res) };
}

function refresh(t: TestApp, cookies: Record<string, string>): Promise<Response> {
  return fetch(`${t.baseUrl}/api/auth/refresh`, {
    method: 'POST',
    headers: { cookie: cookieHeader(cookies), 'x-csrf-token': cookies['ks_csrf'] ?? '' },
  });
}

describe('DoD #1 · refresh 轮换 / 重放 / 吊销（真实 Redis）', () => {
  let t: TestApp;
  const PHONE = '13800000010';

  beforeAll(async () => {
    t = await createTestApp({ users: [await makeUser({ id: 'u_dod', phone: PHONE, password: 'dod-pass' })] });
  });
  afterAll(async () => {
    await t.close();
  });

  it('轮换：refresh 成功发新 token，旧 refreshToken 立即不可重用（重放检测）', async () => {
    const { cookies } = await login(t, PHONE, 'dod-pass');
    const first = await refresh(t, cookies);
    expect(first.status).toBe(200);
    const newCookies = cookiesFrom(first);
    expect(newCookies['ks_refresh']).toBeTruthy();
    expect(newCookies['ks_refresh']).not.toBe(cookies['ks_refresh']); // 确实轮换

    // 重放第一代旧 refreshToken，但携带当前（第二代）CSRF token，
    // 使 double-submit 校验通过、真正进入轮换脚本的重放检测分支。
    // （CSRF token 随轮换更新；若仍用旧 CSRF 会先被 CSRF 拦截，测不到重放吊销。）
    const replayCookies = {
      ks_refresh: cookies['ks_refresh'] ?? '',
      ks_csrf: newCookies['ks_csrf'] ?? '',
    };
    const replay = await refresh(t, replayCookies);
    expect(replay.status).toBe(401);

    // 重放已吊销整个会话 → 第二代新 refreshToken 也立即失效
    const afterReplay = await refresh(t, newCookies);
    expect(afterReplay.status).toBe(401);
  });

  it('CSRF double-submit 缺失/不匹配 → 401', async () => {
    const { cookies } = await login(t, PHONE, 'dod-pass');
    // 缺 x-csrf-token 头
    const noCsrf = await fetch(`${t.baseUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: { cookie: cookieHeader(cookies) },
    });
    expect(noCsrf.status).toBe(401);
    // 错误 csrf
    const badCsrf = await fetch(`${t.baseUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: { cookie: cookieHeader(cookies), 'x-csrf-token': 'wrong' },
    });
    expect(badCsrf.status).toBe(401);
  });

  it('吊销（logout）后：旧 accessToken 被拒、旧 refreshToken 立即失效', async () => {
    const { body, cookies } = await login(t, PHONE, 'dod-pass');

    // 吊销前 accessToken 可用
    const before = await fetch(`${t.baseUrl}/api/me`, { headers: { authorization: `Bearer ${body.accessToken}` } });
    expect(before.status).toBe(200);

    // logout 吊销会话
    const logout = await fetch(`${t.baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${body.accessToken}` },
    });
    expect(logout.status).toBe(204);

    // 旧 accessToken 立即被拒（AuthGuard 查会话已吊销）
    const after = await fetch(`${t.baseUrl}/api/me`, { headers: { authorization: `Bearer ${body.accessToken}` } });
    expect(after.status).toBe(401);

    // 旧 refreshToken 立即失效
    const refreshAfter = await refresh(t, cookies);
    expect(refreshAfter.status).toBe(401);
  });

  it('登出 clears cookie（Set-Cookie 过期）', async () => {
    const { body } = await login(t, PHONE, 'dod-pass');
    const logout = await fetch(`${t.baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${body.accessToken}` },
    });
    const setCookies = logout.headers.getSetCookie?.() ?? [];
    expect(setCookies.some((c) => c.startsWith('ks_refresh=') && /Expires=|Max-Age=0/.test(c))).toBe(true);
  });
});

describe('DoD #3 · 跨用户隔离 404（AuthGuard + 归属校验）', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({
      users: [
        await makeUser({ id: 'u_a', phone: '13800000021', password: 'a-pass' }),
        await makeUser({ id: 'u_b', phone: '13800000022', password: 'b-pass' }),
      ],
      extraControllers: [TestResourceController],
    });
    const ctrl = t.app.get(TestResourceController);
    ctrl.seed({ id: 'res_a', userId: 'u_a', title: 'A 的资源' });
    ctrl.seed({ id: 'res_b', userId: 'u_b', title: 'B 的资源' });
  });
  afterAll(async () => {
    await t.close();
  });

  it('A 的 token 拿 B 的资源 → 404 NOT_FOUND；拿自己的 → 200；B 同理', async () => {
    const a = await login(t, '13800000021', 'a-pass');
    const b = await login(t, '13800000022', 'b-pass');

    const aGetsB = await fetch(`${t.baseUrl}/api/test-resources/res_b`, { headers: { authorization: `Bearer ${a.body.accessToken}` } });
    expect(aGetsB.status).toBe(404);
    expect(((await aGetsB.json()) as { code: string }).code).toBe('NOT_FOUND');

    const aGetsA = await fetch(`${t.baseUrl}/api/test-resources/res_a`, { headers: { authorization: `Bearer ${a.body.accessToken}` } });
    expect(aGetsA.status).toBe(200);
    expect(((await aGetsA.json()) as { userId: string }).userId).toBe('u_a');

    const bGetsA = await fetch(`${t.baseUrl}/api/test-resources/res_a`, { headers: { authorization: `Bearer ${b.body.accessToken}` } });
    expect(bGetsA.status).toBe(404);

    const bGetsB = await fetch(`${t.baseUrl}/api/test-resources/res_b`, { headers: { authorization: `Bearer ${b.body.accessToken}` } });
    expect(bGetsB.status).toBe(200);
  });

  it('无 token 访问受保护资源 → 401（AuthGuard 先于归属校验）', async () => {
    const res = await fetch(`${t.baseUrl}/api/test-resources/res_a`);
    expect(res.status).toBe(401);
  });

  it('不存在的资源 → 404（不泄露存在性）', async () => {
    const a = await login(t, '13800000021', 'a-pass');
    const res = await fetch(`${t.baseUrl}/api/test-resources/res_none`, { headers: { authorization: `Bearer ${a.body.accessToken}` } });
    expect(res.status).toBe(404);
  });
});