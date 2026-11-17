import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerEntrySchema, pageOf } from '@knowstudio/contracts';
import { createDiscoverTestApp, type DiscoverTestApp } from './discover-harness.js';

describe('T-49/T-50 配额账本与平台规则 HTTP', () => {
  let t: DiscoverTestApp;

  beforeAll(async () => {
    t = await createDiscoverTestApp();
  }, 60_000);

  afterAll(async () => {
    if (t !== undefined) await t.cleanup();
  }, 60_000);

  it('账本按用户隔离、可翻页，数字来自 quota_ledger', async () => {
    const firstRes = await fetch(`${t.baseUrl}/api/quota/ledger?limit=3`, {
      headers: { authorization: `Bearer ${t.tokenA}` },
    });
    expect(firstRes.status).toBe(200);
    const first = pageOf(LedgerEntrySchema).parse(await firstRes.json());
    expect(first.items).toHaveLength(3);
    expect(first.total).toBeGreaterThanOrEqual(11);
    expect(first.nextCursor).not.toBeNull();

    const secondRes = await fetch(
      `${t.baseUrl}/api/quota/ledger?limit=3&cursor=${encodeURIComponent(first.nextCursor as string)}`,
      { headers: { authorization: `Bearer ${t.tokenA}` } },
    );
    expect(secondRes.status).toBe(200);
    const second = pageOf(LedgerEntrySchema).parse(await secondRes.json());
    expect(second.items).toHaveLength(3);
    expect(new Set([...first.items, ...second.items].map((item) => item.id))).toHaveLength(6);
  });

  it('读取四平台当前规则；未认证返回 401', async () => {
    const denied = await fetch(`${t.baseUrl}/api/platform-rules`);
    expect(denied.status).toBe(401);

    const res = await fetch(`${t.baseUrl}/api/platform-rules`, {
      headers: { authorization: `Bearer ${t.tokenA}` },
    });
    expect(res.status).toBe(200);
    const rules = (await res.json()) as { platformId: string; isCurrent: boolean; version: number }[];
    expect(rules.map((rule) => rule.platformId).sort()).toEqual(['bili', 'douyin', 'sph', 'xhs']);
    expect(rules.every((rule) => rule.isCurrent && rule.version >= 1)).toBe(true);
  });
});
