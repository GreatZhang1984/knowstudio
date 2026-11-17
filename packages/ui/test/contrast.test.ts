import { describe, expect, it } from 'vitest';
import {
  AA_NORMAL_TEXT,
  contrastRatio,
  hslToRgb,
  meetContrast,
  parseHex,
  relativeLuminance,
  rgbToHsl,
  toHex,
} from '../src/contrast';
import { PALETTE, SPEC_ORIGINAL_MUTED, STAGES } from '../src/tokens';
import type { Palette, ThemeMode } from '../src/tokens';

const CONTAINER_KEYS = ['bg', 'bg2', 'surface', 'surface2', 'overlay'] as const satisfies readonly (keyof Palette)[];
const FG_KEYS = ['muted', 'text2', 'text'] as const satisfies readonly (keyof Palette)[];
const MODES = ['dark', 'light'] as const satisfies readonly ThemeMode[];

describe('WCAG 2.x 公式自检', () => {
  it('黑白为 21:1，同色为 1:1', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 6);
    expect(contrastRatio('#161b27', '#161b27')).toBeCloseTo(1, 6);
  });

  it('相对亮度端点与顺序无关', () => {
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 12);
    expect(contrastRatio('#767676', '#ffffff')).toBeCloseTo(4.5422, 4);
    expect(contrastRatio('#ffffff', '#767676')).toBeCloseTo(contrastRatio('#767676', '#ffffff'), 12);
  });

  it('hex 与 HSL 往返在 8bit 量化内无损', () => {
    for (const hex of ['#6b7690', '#8a93a8', '#2dd4bf', '#f5a524', '#a78bfa', '#fb7185']) {
      expect(toHex(hslToRgb(rgbToHsl(parseHex(hex))))).toBe(hex);
    }
    expect(parseHex('#abc')).toEqual({ r: 170, g: 187, b: 204 });
    expect(() => parseHex('#12345')).toThrow();
  });
});

describe('架构 §11.5 对比度实测：SPEC 原值不达标', () => {
  it('深色 --muted #6b7690 on --surface #161b27 = 3.7857:1 < 4.5', () => {
    const ratio = contrastRatio(SPEC_ORIGINAL_MUTED.dark, '#161b27');
    expect(ratio).toBeCloseTo(3.7857, 4);
    expect(ratio).toBeLessThan(AA_NORMAL_TEXT);
  });

  it('浅色 --muted #8b93a7 on --surface #ffffff = 3.0750:1 < 4.5', () => {
    const ratio = contrastRatio(SPEC_ORIGINAL_MUTED.light, '#ffffff');
    expect(ratio).toBeCloseTo(3.075, 4);
    expect(ratio).toBeLessThan(AA_NORMAL_TEXT);
  });
});

describe('提亮后的 --muted 实测值', () => {
  it('深色 #8a93a8 on --surface = 5.5890:1，最不利容器 --overlay = 4.5290:1', () => {
    expect(PALETTE.dark.muted).toBe('#8a93a8');
    expect(contrastRatio(PALETTE.dark.muted, PALETTE.dark.surface)).toBeCloseTo(5.589, 4);
    expect(contrastRatio(PALETTE.dark.muted, PALETTE.dark.overlay)).toBeCloseTo(4.529, 4);
  });

  it('浅色 #646d84 on --surface = 5.1692:1，最不利容器 --bg = 4.5657:1', () => {
    expect(PALETTE.light.muted).toBe('#646d84');
    expect(contrastRatio(PALETTE.light.muted, PALETTE.light.surface)).toBeCloseTo(5.1692, 4);
    expect(contrastRatio(PALETTE.light.muted, PALETTE.light.bg)).toBeCloseTo(4.5657, 4);
  });

  it('token 固化值与求解器结果一致（防止 token 与算法漂移）', () => {
    expect(meetContrast(SPEC_ORIGINAL_MUTED.dark, PALETTE.dark.overlay).hex).toBe(PALETTE.dark.muted);
    expect(meetContrast(SPEC_ORIGINAL_MUTED.light, PALETTE.light.bg).hex).toBe(PALETTE.light.muted);
  });

  it('求解器对已达标色不做调整', () => {
    const fix = meetContrast(PALETTE.dark.muted, PALETTE.dark.surface);
    expect(fix.steps).toBe(0);
    expect(fix.hex).toBe(PALETTE.dark.muted);
  });
});

describe('两套主题全部前景 × 全部容器均达 AA', () => {
  for (const mode of MODES) {
    for (const fg of FG_KEYS) {
      for (const bg of CONTAINER_KEYS) {
        it(`${mode} --${fg} on --${bg} ≥ 4.5:1`, () => {
          expect(contrastRatio(PALETTE[mode][fg], PALETTE[mode][bg])).toBeGreaterThanOrEqual(
            AA_NORMAL_TEXT,
          );
        });
      }
    }
  }
});

describe('步进器阶段色底上的序号', () => {
  it('阶段色直接写在自己的 dim 底上不达标，故序号改用 --text', () => {
    // 实测基线：浅色四段全不达标，深色只有紫段不达标。
    expect(contrastRatio('#2dd4bf', '#d3f5ef')).toBeCloseTo(1.6024, 4);
    expect(contrastRatio('#a78bfa', '#3b2f63')).toBeCloseTo(4.3529, 4);
    for (const stage of STAGES) {
      expect(contrastRatio(stage.color, stage.dim.light), stage.label).toBeLessThan(AA_NORMAL_TEXT);
    }
    expect(contrastRatio(STAGES[2].color, STAGES[2].dim.dark)).toBeLessThan(AA_NORMAL_TEXT);
  });

  for (const mode of MODES) {
    for (const stage of STAGES) {
      it(`${mode} ${stage.label} 序号 --text on dim ≥ 4.5:1`, () => {
        expect(contrastRatio(PALETTE[mode].text, stage.dim[mode])).toBeGreaterThanOrEqual(
          AA_NORMAL_TEXT,
        );
      });

      it(`${mode} ${stage.label} 完成态深墨色 on 阶段色 ≥ 4.5:1`, () => {
        expect(contrastRatio('#0d1017', stage.color)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
      });
    }
  }
});