import { describe, expect, it } from 'vitest';
import {
  ApiErrorSchema,
  ERROR_CODES,
  ERROR_HTTP_STATUS,
  GateNotSatisfied,
  NotFound,
  QuotaInsufficient,
  httpStatusOf,
} from '../src/errors.js';

/** 逐字抄自架构 §10.2（第 1838–1852 行），独立于被测的 ERROR_HTTP_STATUS。 */
const EXPECTED_HTTP_STATUS: Record<string, number> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  QUOTA_INSUFFICIENT: 402,
  NOT_FOUND: 404,
  GATE_NOT_SATISFIED: 409,
  RENDER_IN_PROGRESS: 409,
  SCRIPT_LOCKED: 409,
  AUTOSAVE_CONFLICT: 409,
  STALE_ASSET: 409,
  UPLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  COMPLIANCE_BLOCKED: 422,
  RATE_LIMITED: 429,
  UPSTREAM_FAILED: 502,
  RENDER_QUEUE_UNAVAILABLE: 503,
};

describe('错误码体系（架构 §10.2）', () => {
  it('15 个码，与架构表一致', () => {
    expect(ERROR_CODES).toHaveLength(15);
    expect([...ERROR_CODES].sort()).toEqual(
      [
        'VALIDATION_FAILED', 'UNAUTHENTICATED', 'QUOTA_INSUFFICIENT', 'NOT_FOUND',
        'GATE_NOT_SATISFIED', 'RENDER_IN_PROGRESS', 'SCRIPT_LOCKED', 'AUTOSAVE_CONFLICT',
        'STALE_ASSET', 'UPLOAD_TOO_LARGE', 'UNSUPPORTED_MEDIA_TYPE', 'COMPLIANCE_BLOCKED',
        'RATE_LIMITED', 'UPSTREAM_FAILED', 'RENDER_QUEUE_UNAVAILABLE',
      ].sort(),
    );
  });

  it('每个码都能判别联合解析，且 details 形状被强制', () => {
    const samples: Record<string, unknown> = {
      VALIDATION_FAILED: { fields: [{ path: 'title', message: '必填' }] },
      UNAUTHENTICATED: { loginUrl: '/login?returnTo=%2Fstudio' },
      QUOTA_INSUFFICIENT: { need: 2, left: 1, resetAt: '2026-12-01T00:00:00Z', options: [{ kind: 'upgrade', label: '升级套餐' }] },
      NOT_FOUND: {},
      GATE_NOT_SATISFIED: { requiredGate: 'G3', redirectTo: '/studio/w_1/render', reason: 'HD_RENDER_NOT_SUCCEEDED' },
      RENDER_IN_PROGRESS: { activeJobId: 'job_88' },
      SCRIPT_LOCKED: { unlockUrl: '/studio/w_1/script' },
      AUTOSAVE_CONFLICT: { serverVersion: 4, serverSnapshot: { version: 4, sections: [] }, clientSnapshot: { version: 3, sections: [] } },
      STALE_ASSET: { scriptVersion: 5, assetVersion: 4 },
      UPLOAD_TOO_LARGE: { maxBytes: 20_971_520 },
      UNSUPPORTED_MEDIA_TYPE: { allowed: ['image/png', 'image/jpeg'] },
      COMPLIANCE_BLOCKED: { reportId: 'rep_1', blockingItems: [] },
      RATE_LIMITED: { retryAfterSec: 30 },
      UPSTREAM_FAILED: { port: 'SourceAdapter', providers: ['zhihu'] },
      RENDER_QUEUE_UNAVAILABLE: { retryAfterSec: 5 },
    };
    expect(Object.keys(samples).sort()).toEqual([...ERROR_CODES].sort());
    for (const code of ERROR_CODES) {
      const parsed = ApiErrorSchema.parse({ code, message: 'x', details: samples[code] });
      expect(parsed.code).toBe(code);
    }
  });

  it('15 个码的 HTTP 状态逐一等于架构 §10.2 表（不是自证查表）', () => {
    expect(Object.keys(EXPECTED_HTTP_STATUS).sort()).toEqual([...ERROR_CODES].sort());
    for (const code of ERROR_CODES) {
      expect(httpStatusOf(code), `${code} 状态码与架构表不符`).toBe(EXPECTED_HTTP_STATUS[code]);
    }
  });

  it('GATE_NOT_SATISFIED 与 COMPLIANCE_BLOCKED 状态码不同（修复 UI 不同）', () => {
    expect(httpStatusOf('GATE_NOT_SATISFIED')).toBe(409);
    expect(httpStatusOf('COMPLIANCE_BLOCKED')).toBe(422);
  });

  it('跨用户访问一律 404 而非 403，避免枚举探测', () => {
    expect(httpStatusOf('NOT_FOUND')).toBe(404);
    expect(ERROR_CODES).not.toContain('FORBIDDEN');
  });

  it('409 家族共 5 个码，前端需分别分支', () => {
    const conflicts = ERROR_CODES.filter((c) => ERROR_HTTP_STATUS[c] === 409);
    expect(conflicts).toHaveLength(5);
  });

  it('details 缺字段被拒（禁止静默失败）', () => {
    expect(
      QuotaInsufficient.safeParse({ code: 'QUOTA_INSUFFICIENT', message: 'x', details: { need: 2 } }).success,
    ).toBe(false);
    expect(
      GateNotSatisfied.safeParse({
        code: 'GATE_NOT_SATISFIED', message: 'x',
        details: { requiredGate: 'G3', redirectTo: '/x', reason: 'NOT_A_REASON' },
      }).success,
    ).toBe(false);
  });

  it('requiredGate 不接受 G5（G5 是静态禁令，不是可满足的门）', () => {
    expect(
      GateNotSatisfied.safeParse({
        code: 'GATE_NOT_SATISFIED', message: 'x',
        details: { requiredGate: 'G5', redirectTo: '/x', reason: 'SCRIPT_NOT_CONFIRMED' },
      }).success,
    ).toBe(false);
  });

  it('NOT_FOUND 的 details 是 strict 空对象，不泄露资源是否存在', () => {
    expect(NotFound.safeParse({ code: 'NOT_FOUND', message: 'x', details: { hint: '属于他人' } }).success).toBe(false);
  });

  it('未知 code 被拒', () => {
    expect(ApiErrorSchema.safeParse({ code: 'TEAPOT', message: 'x', details: {} }).success).toBe(false);
  });
});