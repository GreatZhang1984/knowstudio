import { describe, expect, it } from 'vitest';
import { createTestApp } from './helpers/app.js';

describe('启动探针', () => {
  it('createTestApp 空用户 boot + listen(0) + fetch 401', async () => {
    const t = await createTestApp({ users: [] });
    try {
      const res = await fetch(`${t.baseUrl}/api/me`);
      expect(res.status).toBe(401);
    } finally {
      await t.close();
    }
  });
});