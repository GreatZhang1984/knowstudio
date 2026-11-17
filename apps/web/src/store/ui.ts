import { create } from 'zustand';
import type { ThemeMode } from '@knowstudio/ui';

/** 与 index.html 内联首帧脚本共用同一个 key，否则刷新会闪回深色。 */
const THEME_KEY = 'knowstudio.theme';

const savedTheme = (): ThemeMode =>
  globalThis.localStorage?.getItem(THEME_KEY) === 'light' ? 'light' : 'dark';

interface UiState {
  theme: ThemeMode;
  /** <960px 时侧边栏抽屉的开合；≥960px 常驻，忽略此值。 */
  sidebarOpen: boolean;
  toggleTheme: () => void;
  setSidebarOpen: (open: boolean) => void;
}

/** 架构 §11.2 的全局 UI store：只放与 workId 无关的状态，业务状态一律走 Query。 */
export const useUiStore = create<UiState>()((set) => ({
  theme: savedTheme(),
  sidebarOpen: false,
  toggleTheme: () =>
    set((s) => {
      const theme: ThemeMode = s.theme === 'dark' ? 'light' : 'dark';
      globalThis.localStorage?.setItem(THEME_KEY, theme);
      return { theme };
    }),
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
}));