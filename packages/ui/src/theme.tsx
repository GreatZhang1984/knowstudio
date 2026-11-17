import { useLayoutEffect } from 'react';
import type { ReactNode } from 'react';
import { ConfigProvider, theme as antdTheme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { antdComponentsOf, antdTokenOf } from './tokens';
import type { ThemeMode } from './tokens';

export interface KnowStudioThemeProviderProps {
  mode: ThemeMode;
  children: ReactNode;
}

/**
 * 架构 §11.4 的 token 注入点。阶段色不在这里，避免全局主色随阶段乱跳。
 * data-theme 用 layout effect 同步：AntD 的 CSS-in-JS 与 tokens.css 的变量必须在同一帧生效，
 * 否则切换瞬间会出现半深半浅。首帧由 index.html 的内联脚本先落 attribute。
 */
export function KnowStudioThemeProvider({ mode, children }: KnowStudioThemeProviderProps) {
  useLayoutEffect(() => {
    document.documentElement.dataset['theme'] = mode;
  }, [mode]);

  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: mode === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        token: antdTokenOf(mode),
        components: antdComponentsOf(mode),
      }}
    >
      {children}
    </ConfigProvider>
  );
}