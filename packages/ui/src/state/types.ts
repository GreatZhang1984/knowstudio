import type {
  ApiErrorFor,
  ComplianceItem,
  ErrorCode,
  GateId,
  GateReason,
  ScriptSnapshot,
} from '@knowstudio/contracts';

/**
 * 异常态基座的公共类型（T-08 / SPEC §9）。
 *
 * 两条硬约束贯穿本目录：
 * 1. 错误码只有一个来源 —— `@knowstudio/contracts` 的 `ErrorCode`，本目录不另立枚举。
 * 2. 分支只看 `code` 与 `details`，**绝不解析 message**（架构 §10.2）。
 *    message 只允许作为「兜底展示文本」出现在 UI 上，不参与任何判定。
 */

/** 呈现级别：屏可以按自己的上下文降级（例如整页错误在卡片里降级为 section）。 */
export type PresentationLevel = 'page' | 'section' | 'inline' | 'banner' | 'modal';

/** 语义色调。只决定左侧强调条与图标，语义永远同时由文本承载（不靠颜色单独表意）。 */
export type StateTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

/**
 * 通用组件接受的动作模型：文案与回调全部由屏传入，
 * 通用组件里不写死任何一个屏的业务（SPEC §9 十屏复用同一套组件）。
 */
export interface StateAction {
  key: string;
  label: string;
  /** 主行动：只影响排序与字重，不引入新颜色。 */
  primary?: boolean;
  disabled?: boolean;
  /** 禁用原因，必须让用户看得见（例如「合规阻断，先修复」）。 */
  disabledReason?: string;
  onClick?: () => void;
  href?: string;
}

export interface FieldIssue {
  path: string;
  message: string;
}

export interface QuotaOption {
  kind: string;
  label: string;
}

/**
 * 恢复动作类型。每个错误码至少给出一个，UI 按 kind 决定交互形态，
 * 载荷字段全部来自 contracts 的 details，不额外发明字段。
 */
export type RecoveryAction =
  | { kind: 'retry'; label: string; retryAfterSec?: number }
  | { kind: 'go-back'; label: string }
  | { kind: 'navigate'; label: string; to: string }
  | { kind: 'relogin'; label: string; loginUrl: string; returnTo?: string }
  | {
      kind: 'upgrade-or-wait';
      label: string;
      need: number;
      left: number;
      resetAt: string;
      options: readonly QuotaOption[];
    }
  | {
      kind: 'fix-compliance';
      label: string;
      reportId: string;
      blockingCount: number;
      items: readonly ComplianceItem[];
    }
  | {
      kind: 'choose-version';
      label: string;
      serverVersion: number;
      serverSnapshot: ScriptSnapshot;
      clientSnapshot: ScriptSnapshot;
    }
  | { kind: 'fix-fields'; label: string; fields: readonly FieldIssue[] }
  | { kind: 'shrink-upload'; label: string; maxBytes: number }
  | { kind: 'convert-upload'; label: string; allowed: readonly string[] }
  | { kind: 'view-job'; label: string; activeJobId: string }
  | { kind: 'rerender'; label: string; scriptVersion: number; assetVersion: number }
  | { kind: 'contact-support'; label: string; port?: string; providers?: readonly string[] };

export type RecoveryKind = RecoveryAction['kind'];

/** 屏提供的环境信息。通用组件不写死业务路由，跳转目标一律由屏或 details 给出。 */
export interface ErrorUiContext {
  /** 当前页面路径，用于 `/login?returnTo=`（SPEC §9 全局规则）。 */
  returnTo?: string;
  /** 时间本地化函数（架构 §10.1「前端本地化」）。默认实现见 format.ts。 */
  formatTime?: (iso: string) => string;
}

/** 单个错误码的 UI 规格。details 的类型由 contracts 精确推导，写错字段名即 typecheck 失败。 */
export interface ErrorUiEntry<C extends ErrorCode> {
  level: PresentationLevel;
  tone: StateTone;
  title: string;
  /** 用户可读文案。只允许消费 details 与固定文案；返回空串时 UI 用 message 兜底展示。 */
  body: (details: ApiErrorFor<C>['details'], ctx: ErrorUiContext) => string;
  /** 恢复动作，按主次排序。 */
  recovery: (
    details: ApiErrorFor<C>['details'],
    ctx: ErrorUiContext,
  ) => readonly RecoveryAction[];
  /** 本项消费的 details 字段。键名受 contracts 类型约束，用于契约变更时的影响面盘点。 */
  detailsUsed: readonly (keyof ApiErrorFor<C>['details'])[];
  /**
   * 渲染该错误态时是否必须保留用户已输入内容。
   * SPEC §9 全局：5xx → 统一错误页 + 重试 + **不丢用户输入**；
   * §9 各屏：生成失败保留已编辑 / 保留上批 / 保留部分结果。
   */
  keepUserInput: boolean;
}

/** 编译期穷举：contracts 新增错误码而这里没补，typecheck 立即失败。 */
export type ErrorUiMap = { [C in ErrorCode]: ErrorUiEntry<C> };

/** 闸门错误的附加信息，供屏直接复用既有 `<GateLocked>`（T-15），不在这里重抄一份闸门文案。 */
export interface GateErrorInfo {
  requiredGate: GateId;
  redirectTo: string;
  reason: GateReason;
}

export interface ResolvedErrorUi {
  code: ErrorCode;
  level: PresentationLevel;
  tone: StateTone;
  title: string;
  body: string;
  actions: readonly RecoveryAction[];
  keepUserInput: boolean;
  gate?: GateErrorInfo;
}