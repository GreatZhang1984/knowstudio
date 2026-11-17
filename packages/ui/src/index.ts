/**
 * @knowstudio/ui —— 深浅主题、阶段色 token 与 AntD 之外的自建模式（架构 §11.4）。
 * 样式入口：`@knowstudio/ui/tokens.css`；组件样式由本模块副作用引入。
 */
import './components.css';

export { KnowStudioThemeProvider } from './theme';
export type { KnowStudioThemeProviderProps } from './theme';
export { StageStepper } from './StageStepper';
export type { StageStepperProps } from './StageStepper';
export { GateLocked, G5_EXPORT_NOTICE } from './GateLocked';
export type { GateLockedProps } from './GateLocked';
/** 异常态基座（T-08 / SPEC §9）：空/加载/错误/部分成功/离线横幅 + 错误码 → UI 映射。 */
export * from './state';
export {
  PALETTE,
  SPEC_ORIGINAL_MUTED,
  STAGES,
  stageOfPhase,
  stageVars,
  antdTokenOf,
  antdComponentsOf,
} from './tokens';
export type { Palette, Stage, ThemeMode } from './tokens';