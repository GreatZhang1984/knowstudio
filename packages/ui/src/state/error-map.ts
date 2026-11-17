import { ERROR_HTTP_STATUS } from '@knowstudio/contracts';
import type { ApiError, ApiErrorFor, ErrorCode } from '@knowstudio/contracts';
import { bodyOrMessage, formatBytes, formatTimestamp, formatWaitSeconds } from './format';
import type { ErrorUiContext, ErrorUiEntry, ErrorUiMap, ResolvedErrorUi } from './types';

/**
 * 错误码 → UI 映射表（SPEC §9 / 架构 §10.2）。
 *
 * 穷举性由 `satisfies ErrorUiMap` 在**编译期**保证：ErrorUiMap 是
 * `{ [C in ErrorCode]: ErrorUiEntry<C> }`，contracts 里加一个码而这里没补，
 * `pnpm typecheck` 直接失败；删掉一个码 likewise 失败。
 * 运行期另有 test/state-error-map.test.ts 逐个比对 ERROR_CODES。
 *
 * 每个 entry 的 details 参数类型来自 `ApiErrorFor<C>['details']`，
 * 因此「消费了哪些 details 字段」不是注释里的口头承诺：写错字段名就编译不过。
 */
export const ERROR_UI = {
  VALIDATION_FAILED: {
    level: 'inline',
    tone: 'warning',
    title: '有几项需要修正',
    body: (d) => d.fields.map((f) => `${f.path}：${f.message}`).join('；'),
    recovery: (d) => [{ kind: 'fix-fields', label: '去修正', fields: d.fields }],
    detailsUsed: ['fields'],
    keepUserInput: true,
  },
  UNAUTHENTICATED: {
    level: 'page',
    tone: 'info',
    title: '登录状态已过期',
    body: () => '重新登录后会回到你刚才的页面，继续没做完的事。',
    recovery: (d, ctx) => [
      { kind: 'relogin', label: '重新登录', loginUrl: d.loginUrl, returnTo: ctx.returnTo },
    ],
    detailsUsed: ['loginUrl'],
    // SPEC §9 只对 5xx 明写「不丢用户输入」；401 跳登录前是否必须暂存草稿见报告 [待确认]。
    // 这里取保守值：先保住输入再跳，代价只是多一次暂存。
    keepUserInput: true,
  },
  QUOTA_INSUFFICIENT: {
    level: 'modal',
    tone: 'warning',
    title: '点数不够了',
    body: (d, ctx) =>
      `这一步需要 ${d.need} 点，当前可用 ${d.left} 点。月度额度在 ${formatTimestamp(d.resetAt, ctx.formatTime)} 重置。`,
    recovery: (d) => [
      {
        kind: 'upgrade-or-wait',
        label: '升级或等待重置',
        need: d.need,
        left: d.left,
        resetAt: d.resetAt,
        options: d.options,
      },
    ],
    detailsUsed: ['need', 'left', 'resetAt', 'options'],
    keepUserInput: true,
  },
  NOT_FOUND: {
    level: 'page',
    tone: 'neutral',
    title: '找不到这个内容',
    // 404 同时表示「不存在」与「不属于你」（架构 §10.1 防枚举探测），文案不得区分二者。
    body: () => '它可能已经被删除，或者不在当前账号下。',
    recovery: () => [{ kind: 'go-back', label: '返回上一页' }],
    detailsUsed: [],
    keepUserInput: false,
  },
  GATE_NOT_SATISFIED: {
    level: 'page',
    tone: 'warning',
    title: '这一步还没解锁',
    body: () => '先完成上一步的前置条件，这里会自动解锁。知影不会替你跳过。',
    recovery: (d) => [{ kind: 'navigate', label: '回到上一门', to: d.redirectTo }],
    detailsUsed: ['requiredGate', 'redirectTo', 'reason'],
    keepUserInput: false,
  },
  RENDER_IN_PROGRESS: {
    level: 'inline',
    tone: 'info',
    title: '已经有一条在渲染',
    body: () => '每个账号同时只能渲染一条视频。等当前任务结束再来，期间可以先去写平台标题。',
    recovery: (d) => [{ kind: 'view-job', label: '查看渲染进度', activeJobId: d.activeJobId }],
    detailsUsed: ['activeJobId'],
    keepUserInput: true,
  },
  SCRIPT_LOCKED: {
    level: 'banner',
    tone: 'info',
    title: '文案已确认并锁定',
    body: () => '已确认的文案不能直接改。解锁会让高清成片与合规报告失效，需要重新渲染与重新检查。',
    recovery: (d) => [{ kind: 'navigate', label: '解锁并重新确认', to: d.unlockUrl }],
    detailsUsed: ['unlockUrl'],
    keepUserInput: true,
  },
  AUTOSAVE_CONFLICT: {
    level: 'modal',
    tone: 'warning',
    title: '两个版本撞上了',
    body: (d) =>
      `服务器已经到第 ${d.serverVersion} 版，你手里的改动基于更早的版本。两版都留着，选一个保留，或逐行对比。`,
    recovery: (d) => [
      {
        kind: 'choose-version',
        label: '选择保留哪一版',
        serverVersion: d.serverVersion,
        serverSnapshot: d.serverSnapshot,
        clientSnapshot: d.clientSnapshot,
      },
    ],
    detailsUsed: ['serverVersion', 'serverSnapshot', 'clientSnapshot'],
    keepUserInput: true,
  },
  STALE_ASSET: {
    level: 'section',
    tone: 'warning',
    title: '成片已过期',
    body: (d) =>
      `文案在第 ${d.scriptVersion} 版，成片还停在第 ${d.assetVersion} 版，需要重新渲染才能对上。`,
    recovery: (d) => [
      {
        kind: 'rerender',
        label: '重新渲染',
        scriptVersion: d.scriptVersion,
        assetVersion: d.assetVersion,
      },
    ],
    detailsUsed: ['scriptVersion', 'assetVersion'],
    keepUserInput: true,
  },
  UPLOAD_TOO_LARGE: {
    level: 'inline',
    tone: 'warning',
    title: '文件太大了',
    body: (d) => `单个文件上限 ${formatBytes(d.maxBytes)}，压缩或裁剪后再上传。`,
    recovery: (d) => [{ kind: 'shrink-upload', label: '换一个更小的文件', maxBytes: d.maxBytes }],
    detailsUsed: ['maxBytes'],
    keepUserInput: true,
  },
  UNSUPPORTED_MEDIA_TYPE: {
    level: 'inline',
    tone: 'warning',
    title: '这种格式还不支持',
    body: (d) => (d.allowed.length === 0 ? '' : `目前只接受：${d.allowed.join('、')}。`),
    recovery: (d) => [{ kind: 'convert-upload', label: '换个格式再上传', allowed: d.allowed }],
    detailsUsed: ['allowed'],
    keepUserInput: true,
  },
  COMPLIANCE_BLOCKED: {
    level: 'section',
    tone: 'danger',
    title: '有阻断项，暂时不能导出',
    body: (d) =>
      `${d.blockingItems.length} 处需要处理：替换素材、移除内容，或上传授权凭证。修好后重新检查即可导出。`,
    recovery: (d) => [
      {
        kind: 'fix-compliance',
        label: '去修复合规项',
        reportId: d.reportId,
        blockingCount: d.blockingItems.length,
        items: d.blockingItems,
      },
    ],
    detailsUsed: ['reportId', 'blockingItems'],
    keepUserInput: true,
  },
  RATE_LIMITED: {
    level: 'banner',
    tone: 'warning',
    title: '操作太频繁了',
    body: (d) =>
      d.retryAfterSec > 0
        ? `歇 ${formatWaitSeconds(d.retryAfterSec)} 再试，内容都还在。`
        : '稍等一下再试，内容都还在。',
    recovery: (d) => [{ kind: 'retry', label: '重试', retryAfterSec: d.retryAfterSec }],
    detailsUsed: ['retryAfterSec'],
    keepUserInput: true,
  },
  UPSTREAM_FAILED: {
    level: 'page',
    tone: 'danger',
    title: '上游服务暂时不可用',
    body: (d) =>
      `${d.port} 的供应商都没成功（已尝试：${d.providers.join('、')}）。你的输入都还在，可以直接重试。`,
    recovery: (d) => [
      { kind: 'retry', label: '重试' },
      { kind: 'contact-support', label: '联系支持', port: d.port, providers: d.providers },
    ],
    detailsUsed: ['port', 'providers'],
    keepUserInput: true,
  },
  RENDER_QUEUE_UNAVAILABLE: {
    level: 'page',
    tone: 'danger',
    title: '渲染队列暂时不可用',
    body: (d) =>
      d.retryAfterSec > 0
        ? `队列正在恢复，${formatWaitSeconds(d.retryAfterSec)} 后可以再试。你的文案与素材都还在。`
        : '队列正在恢复，稍后再试。你的文案与素材都还在。',
    recovery: (d) => [{ kind: 'retry', label: '重试', retryAfterSec: d.retryAfterSec }],
    detailsUsed: ['retryAfterSec'],
    keepUserInput: true,
  },
} satisfies ErrorUiMap;

/** 5xx 判定只看契约里的 HTTP 状态表，不看 message、不猜文案。 */
export const isServerError = (code: ErrorCode): boolean => ERROR_HTTP_STATUS[code] >= 500;

/**
 * 同一份数据的「按码索引」视图。
 * 为什么需要它：`ERROR_UI` 用 satisfies 保留了字面量的窄类型，直接用泛型 C 去索引
 * 会得到 15 个 entry 的联合（TS 不会把 Extract<..., {code: C}> 化简），调用 body 会被拒绝。
 * 这里用一次**普通赋值**（不是 as 断言）把它收成 ErrorUiMap，索引即得 ErrorUiEntry<C>，
 * 全程零断言、零 any。
 */
const ENTRIES: ErrorUiMap = ERROR_UI;

/**
 * 泛型收敛点：把「某个具体码」的 entry 应用到「同码的 details」上。
 * 用泛型 C 把 code 与 details 绑在一起，因此不存在 details 与 code 错配的可能。
 */
function resolveEntry<C extends ErrorCode>(
  code: C,
  details: ApiErrorFor<C>['details'],
  message: string,
  ctx: ErrorUiContext,
): ResolvedErrorUi {
  const entry: ErrorUiEntry<C> = ENTRIES[code];
  return {
    code,
    level: entry.level,
    tone: entry.tone,
    title: entry.title,
    body: bodyOrMessage(entry.body(details, ctx), message),
    actions: entry.recovery(details, ctx),
    keepUserInput: entry.keepUserInput,
  };
}

/**
 * 唯一的运行期分派入口：**switch on code**，穷举 15 个码。
 * contracts 加码后这里少一个 case，TS 会报「并非所有代码路径都返回值」，
 * 与 satisfies 形成两道编译期闸门。message 一路只作为展示兜底传下去。
 */
export function resolveErrorUi(error: ApiError, ctx: ErrorUiContext = {}): ResolvedErrorUi {
  switch (error.code) {
    case 'VALIDATION_FAILED':
      return resolveEntry('VALIDATION_FAILED', error.details, error.message, ctx);
    case 'UNAUTHENTICATED':
      return resolveEntry('UNAUTHENTICATED', error.details, error.message, ctx);
    case 'QUOTA_INSUFFICIENT':
      return resolveEntry('QUOTA_INSUFFICIENT', error.details, error.message, ctx);
    case 'NOT_FOUND':
      return resolveEntry('NOT_FOUND', error.details, error.message, ctx);
    case 'GATE_NOT_SATISFIED':
      return {
        ...resolveEntry('GATE_NOT_SATISFIED', error.details, error.message, ctx),
        gate: {
          requiredGate: error.details.requiredGate,
          redirectTo: error.details.redirectTo,
          reason: error.details.reason,
        },
      };
    case 'RENDER_IN_PROGRESS':
      return resolveEntry('RENDER_IN_PROGRESS', error.details, error.message, ctx);
    case 'SCRIPT_LOCKED':
      return resolveEntry('SCRIPT_LOCKED', error.details, error.message, ctx);
    case 'AUTOSAVE_CONFLICT':
      return resolveEntry('AUTOSAVE_CONFLICT', error.details, error.message, ctx);
    case 'STALE_ASSET':
      return resolveEntry('STALE_ASSET', error.details, error.message, ctx);
    case 'UPLOAD_TOO_LARGE':
      return resolveEntry('UPLOAD_TOO_LARGE', error.details, error.message, ctx);
    case 'UNSUPPORTED_MEDIA_TYPE':
      return resolveEntry('UNSUPPORTED_MEDIA_TYPE', error.details, error.message, ctx);
    case 'COMPLIANCE_BLOCKED':
      return resolveEntry('COMPLIANCE_BLOCKED', error.details, error.message, ctx);
    case 'RATE_LIMITED':
      return resolveEntry('RATE_LIMITED', error.details, error.message, ctx);
    case 'UPSTREAM_FAILED':
      return resolveEntry('UPSTREAM_FAILED', error.details, error.message, ctx);
    case 'RENDER_QUEUE_UNAVAILABLE':
      return resolveEntry('RENDER_QUEUE_UNAVAILABLE', error.details, error.message, ctx);
  }
}