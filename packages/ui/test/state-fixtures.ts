import { ApiErrorSchema } from '@knowstudio/contracts';
import type { ApiError, ApiErrorFor, ErrorCode, ScriptSnapshot } from '@knowstudio/contracts';

/**
 * 15 个错误码的真实信封样本。
 * 每一份都过 `ApiErrorSchema.parse`，所以样本不可能与契约漂移：
 * contracts 改了 details 形状，这里立刻抛错，而不是让测试对着假数据绿。
 */

const snapshot = (version: number, text: string): ScriptSnapshot => ({
  version,
  sections: [
    {
      id: 'sec_1',
      kind: 'hook3s',
      ord: 0,
      rangeStart: 0,
      rangeEnd: 3,
      lines: [
        {
          id: 'ln_1',
          sectionId: 'sec_1',
          ord: 0,
          text,
          editedByUser: true,
          charCount: text.length,
        },
      ],
    },
  ],
});

const RAW = {
  VALIDATION_FAILED: {
    code: 'VALIDATION_FAILED',
    message: 'validation failed',
    details: {
      fields: [
        { path: 'title', message: '标题不能为空' },
        { path: 'keyword', message: '关键词至少 2 个字' },
      ],
    },
  },
  UNAUTHENTICATED: {
    code: 'UNAUTHENTICATED',
    message: 'token expired',
    details: { loginUrl: '/login' },
  },
  QUOTA_INSUFFICIENT: {
    code: 'QUOTA_INSUFFICIENT',
    message: 'quota insufficient',
    details: {
      need: 2,
      left: 1,
      resetAt: '2026-12-01T00:00:00Z',
      options: [
        { kind: 'upgrade', label: '升级到 Pro' },
        { kind: 'wait', label: '等待月度重置' },
      ],
    },
  },
  NOT_FOUND: { code: 'NOT_FOUND', message: 'not found', details: {} },
  GATE_NOT_SATISFIED: {
    code: 'GATE_NOT_SATISFIED',
    message: 'gate not satisfied',
    details: {
      requiredGate: 'G3',
      redirectTo: '/studio/w1/video',
      reason: 'HD_RENDER_NOT_SUCCEEDED',
    },
  },
  RENDER_IN_PROGRESS: {
    code: 'RENDER_IN_PROGRESS',
    message: 'render in progress',
    details: { activeJobId: 'job_1' },
  },
  SCRIPT_LOCKED: {
    code: 'SCRIPT_LOCKED',
    message: 'script locked',
    details: { unlockUrl: '/studio/w1/script/unlock' },
  },
  AUTOSAVE_CONFLICT: {
    code: 'AUTOSAVE_CONFLICT',
    message: 'autosave conflict',
    details: {
      serverVersion: 7,
      serverSnapshot: snapshot(7, '服务器版本的第一句'),
      clientSnapshot: snapshot(6, '我本地改过的第一句'),
    },
  },
  STALE_ASSET: {
    code: 'STALE_ASSET',
    message: 'stale asset',
    details: { scriptVersion: 9, assetVersion: 4 },
  },
  UPLOAD_TOO_LARGE: {
    code: 'UPLOAD_TOO_LARGE',
    message: 'upload too large',
    details: { maxBytes: 20 * 1024 * 1024 },
  },
  UNSUPPORTED_MEDIA_TYPE: {
    code: 'UNSUPPORTED_MEDIA_TYPE',
    message: 'unsupported media type',
    details: { allowed: ['image/png', 'image/jpeg', 'audio/mpeg'] },
  },
  COMPLIANCE_BLOCKED: {
    code: 'COMPLIANCE_BLOCKED',
    message: 'compliance blocked',
    details: {
      reportId: 'rpt_1',
      blockingItems: [
        {
          kind: 'music',
          status: 'block',
          detail: 'BGM 授权凭证缺失',
          blocking: true,
          materialIds: ['mat_3'],
          fixHint: '上传授权凭证或换一首已授权曲目',
        },
        {
          kind: 'content',
          status: 'block',
          detail: '连续 34 字与原文命中',
          blocking: true,
          materialIds: [],
          lineId: 'ln_1',
          fixHint: '重述这一段',
        },
      ],
    },
  },
  RATE_LIMITED: {
    code: 'RATE_LIMITED',
    message: 'rate limited',
    details: { retryAfterSec: 30 },
  },
  UPSTREAM_FAILED: {
    code: 'UPSTREAM_FAILED',
    message: 'upstream failed',
    details: { port: 'llm', providers: ['qwen', 'deepseek'] },
  },
  RENDER_QUEUE_UNAVAILABLE: {
    code: 'RENDER_QUEUE_UNAVAILABLE',
    message: 'render queue unavailable',
    details: { retryAfterSec: 120 },
  },
} as const;

/** 取某个码的样本信封（已按契约校验，details 类型精确到该码）。 */
export function errorFixture<C extends ErrorCode>(code: C): ApiErrorFor<C> {
  const parsed = ApiErrorSchema.parse(RAW[code]);
  // 唯一的断言点：先按契约校验、再核对 code 与请求一致，然后才收窄到 ApiErrorFor<C>。
  if (parsed.code !== code) throw new Error(`样本与请求的错误码不一致：${code}`);
  return parsed as ApiErrorFor<C>;
}

export const ALL_FIXTURES: readonly ApiError[] = Object.keys(RAW).map((code) =>
  ApiErrorSchema.parse(RAW[code as ErrorCode]),
);

/** 固定时间格式化器：让 402 的 resetAt 文案在单测里确定。 */
export const FIXED_TIME = (iso: string): string => `〔${iso}〕`;