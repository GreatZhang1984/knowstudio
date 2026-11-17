import type { ThemeConfig } from 'antd';
import type { Phase } from '@knowstudio/contracts';

/**
 * SPEC §2.4 基础 token。深浅两套共用同一组变量名，切换只换值，
 * 避免组件里出现 `mode === 'dark' ? a : b` 的分叉。
 */
export interface Palette {
  bg: string;
  bg2: string;
  surface: string;
  surface2: string;
  overlay: string;
  line: string;
  text: string;
  text2: string;
  muted: string;
}

export type ThemeMode = 'dark' | 'light';

/**
 * muted 不是 SPEC 原值：原值实测不满足 WCAG AA，按架构 §11.5 提亮/压暗。
 * 取「该主题下最不利容器」为约束（深色 overlay、浅色 bg），
 * 这样 --muted 落在任何容器上都不必再逐处复算。实测记录见 ../CONTRAST.md。
 */
export const PALETTE: Record<ThemeMode, Palette> = {
  dark: {
    bg: '#0d1017',
    bg2: '#11151f',
    surface: '#161b27',
    surface2: '#1c2333',
    overlay: '#232c40',
    line: '#2a3348',
    text: '#eef1f8',
    text2: '#aab3c8',
    muted: '#8a93a8',
  },
  light: {
    bg: '#eef1f6',
    // SPEC 只定义了浅色的 bg/surface/text/text-2/muted，其余按深色的层级次序推导：bg 最暗、surface 最亮。
    bg2: '#f6f8fc',
    surface: '#ffffff',
    surface2: '#f4f6fb',
    overlay: '#ffffff',
    line: '#d7ddea',
    text: '#141a26',
    text2: '#475069',
    muted: '#646d84',
  },
};

/** 提亮前的 SPEC 原值，仅用于对比度回归基线，不参与渲染。 */
export const SPEC_ORIGINAL_MUTED: Record<ThemeMode, string> = {
  dark: '#6b7690',
  light: '#8b93a7',
};

export interface Stage {
  phase: 0 | 1 | 2 | 3;
  key: 'search' | 'topics' | 'video' | 'publish';
  /** SPEC §2.4 的 CSS 变量名后缀，dim 变体为 `${token}-dim`。 */
  token: 'teal' | 'amber' | 'violet' | 'coral';
  label: string;
  short: string;
  color: string;
  dim: Record<ThemeMode, string>;
}

/** SPEC §2.4 阶段签名色。四段固定，不随 AntD 全局主色变化（架构 §11.4）。 */
export const STAGES: readonly [Stage, Stage, Stage, Stage] = [
  {
    phase: 0,
    key: 'search',
    token: 'teal',
    label: '搜素材',
    short: '搜',
    color: '#2dd4bf',
    dim: { dark: '#134e4a', light: '#d3f5ef' },
  },
  {
    phase: 1,
    key: 'topics',
    token: 'amber',
    label: '想选题',
    short: '想',
    color: '#f5a524',
    dim: { dark: '#4a3410', light: '#fbeed3' },
  },
  {
    phase: 2,
    key: 'video',
    token: 'violet',
    label: '做视频',
    short: '做',
    color: '#a78bfa',
    dim: { dark: '#3b2f63', light: '#e9e2fb' },
  },
  {
    phase: 3,
    key: 'publish',
    token: 'coral',
    label: '发平台',
    short: '发',
    color: '#fb7185',
    dim: { dark: '#4c1f2a', light: '#fbe2e7' },
  },
];

/** phase 4「已导出」不是第五段，仍归到「发」段并整体标记完成。 */
export const stageOfPhase = (phase: Phase): Stage => STAGES[phase === 4 ? 3 : phase];

const BRAND = {
  colorPrimary: '#2dd4bf',
  colorSuccess: '#34d399',
  colorWarning: '#fbbf24',
  colorError: '#f87171',
  colorInfo: '#60a5fa',
  borderRadius: 12,
  fontSize: 14,
  fontFamily: 'Inter, "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif',
} as const;

/** 架构 §11.4 token 表。阶段色不在这里，见 stageVars。 */
export function antdTokenOf(mode: ThemeMode): ThemeConfig['token'] {
  const p = PALETTE[mode];
  return {
    ...BRAND,
    colorBgBase: p.bg,
    colorBgContainer: p.surface,
    // AntD 会从 colorBgBase 自行推导浮层底色（深色 #1b2846 / 浅色 #f2f2f2），
    // 那两个值不在对比度矩阵的五个容器里，--muted 落上去等于没实测过。
    // 显式钉到 --overlay，Drawer / Popover / Dropdown / Select 一并收口。
    colorBgElevated: p.overlay,
    colorBorder: p.line,
    colorText: p.text,
    colorTextSecondary: p.text2,
  };
}

export function antdComponentsOf(mode: ThemeMode): ThemeConfig['components'] {
  const p = PALETTE[mode];
  return {
    Table: { headerBg: p.surface2 },
    Modal: { contentBg: p.surface },
  };
}

/** 阶段色以容器级 CSS 变量注入，避免全局主色随阶段乱跳（架构 §11.4）。 */
export function stageVars(phase: Phase, mode: ThemeMode): Record<string, string> {
  const s = stageOfPhase(phase);
  return { '--stage-c': s.color, '--stage-dim': s.dim[mode] };
}