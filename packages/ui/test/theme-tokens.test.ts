import { describe, expect, it } from 'vitest';
import { PALETTE, STAGES, antdComponentsOf, antdTokenOf, stageOfPhase, stageVars } from '../src/tokens';

/** 架构 §11.4 的 token 表，逐字对照。 */
describe('AntD token 表（深色）', () => {
  const token = antdTokenOf('dark');

  it('品牌与语义色、圆角、字号与架构 §11.4 一致', () => {
    expect(token).toMatchObject({
      colorPrimary: '#2dd4bf',
      colorSuccess: '#34d399',
      colorWarning: '#fbbf24',
      colorError: '#f87171',
      colorInfo: '#60a5fa',
      colorBgBase: '#0d1017',
      colorBgContainer: '#161b27',
      colorBorder: '#2a3348',
      colorText: '#eef1f8',
      colorTextSecondary: '#aab3c8',
      borderRadius: 12,
      fontSize: 14,
    });
  });

  it('字体族含中文回退', () => {
    expect(token?.fontFamily).toBe(
      'Inter, "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif',
    );
  });

  it('组件级 Table.headerBg / Modal.contentBg', () => {
    expect(antdComponentsOf('dark')).toEqual({
      Table: { headerBg: '#1c2333' },
      Modal: { contentBg: '#161b27' },
    });
  });

  it('浮层底色钉到 --overlay，不让 AntD 自行推导出矩阵外的背景', () => {
    // 实测：不钉时 Drawer 深色是 #1b2846、浅色是 #f2f2f2，两者都不在对比度矩阵的五个容器里。
    for (const mode of ['dark', 'light'] as const) {
      expect(antdTokenOf(mode)?.colorBgElevated, mode).toBe(PALETTE[mode].overlay);
    }
    expect(antdTokenOf('dark')?.colorBgElevated).toBe('#232c40');
    expect(antdTokenOf('light')?.colorBgElevated).toBe('#ffffff');
  });

  it('浅色沿用同一组品牌色，基础色换成浅色调色板', () => {
    expect(antdTokenOf('light')).toMatchObject({
      colorPrimary: '#2dd4bf',
      colorBgBase: PALETTE.light.bg,
      colorBgContainer: PALETTE.light.surface,
      colorBorder: PALETTE.light.line,
      colorText: PALETTE.light.text,
      colorTextSecondary: PALETTE.light.text2,
      borderRadius: 12,
      fontSize: 14,
    });
    expect(antdComponentsOf('light')).toEqual({
      Table: { headerBg: PALETTE.light.surface2 },
      Modal: { contentBg: PALETTE.light.surface },
    });
  });
});

describe('阶段色不进全局 token（架构 §11.4）', () => {
  const stageColors = STAGES.map((s) => s.color);

  for (const mode of ['dark', 'light'] as const) {
    it(`${mode} 全局 token 里不含想/做/发三段签名色`, () => {
      const values = Object.values(antdTokenOf(mode) ?? {});
      for (const color of stageColors.slice(1)) {
        expect(values).not.toContain(color);
      }
      // 搜段 teal 与 colorPrimary 同值是 SPEC 的既定重合，不算「阶段色泄漏」。
      expect(values).toContain('#2dd4bf');
    });

    it(`${mode} 阶段色只出现在容器级变量里`, () => {
      expect(stageVars(2, mode)).toEqual({
        '--stage-c': '#a78bfa',
        '--stage-dim': STAGES[2].dim[mode],
      });
    });
  }

  it('phase 4 归到发段，不产生第五段', () => {
    expect(stageOfPhase(4)).toBe(STAGES[3]);
    expect(stageOfPhase(0)).toBe(STAGES[0]);
    expect(STAGES).toHaveLength(4);
  });
});