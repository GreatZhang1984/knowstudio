import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AA_NORMAL_TEXT, contrastRatio } from '../src/contrast';
import { PALETTE } from '../src/tokens';
import type { ThemeMode } from '../src/tokens';

/**
 * 异常态基座的样式纪律 + 对比度回归。
 *
 * 两条硬约束：
 * 1. 颜色一律走 token，state.css 里不得出现任何 hex / rgb 字面量；
 * 2. 容器底色只能落在 PALETTE 的五个容器里（--bg / --bg-2 / --surface / --surface-2 / --overlay），
 *    不许造出第六个表面——上一轮 AntD 自行推导 colorBgElevated 就是这么踩坑的。
 * 文本前景 × 容器的每一格都用 src/contrast.ts 的公式实测，数字同步进 ../CONTRAST.md 第四节。
 */

const CSS_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/state/state.css');
const CSS = readFileSync(CSS_PATH, 'utf8');

const CONTAINER_VARS = ['--bg', '--bg-2', '--surface', '--surface-2', '--overlay'] as const;
const TEXT_VARS = ['--text', '--text-2', '--muted'] as const;
/** 装饰性圆点：不承载文本，语义由旁边的文字表达，故允许用语义色做实底。 */
const DECORATIVE_DOT = /__dot\b/;

interface Block {
  selector: string;
  decls: { prop: string; value: string }[];
}

function blocks(css: string): Block[] {
  const out: Block[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m = re.exec(css);
  while (m != null) {
    const selector = (m[1] ?? '').trim();
    const body = m[2] ?? '';
    const decls = [...body.matchAll(/([a-z-]+)\s*:\s*([^;]+);/g)].map((d) => ({
      prop: (d[1] ?? '').trim(),
      value: (d[2] ?? '').trim(),
    }));
    if (!selector.startsWith('@') && !selector.startsWith('/*')) out.push({ selector, decls });
    m = re.exec(css);
  }
  return out;
}

const BLOCKS = blocks(CSS.replace(/\/\*[\s\S]*?\*\//g, ''));

describe('state.css 的 token 纪律', () => {
  it('解析到了真实规则（防止解析器空转导致假绿）', () => {
    expect(BLOCKS.length).toBeGreaterThan(20);
    expect(BLOCKS.some((b) => b.selector === '.ks-state')).toBe(true);
    expect(BLOCKS.some((b) => b.selector === '.ks-offline')).toBe(true);
  });

  it('没有任何 hex / rgb / hsl 字面量', () => {
    const withoutComments = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(withoutComments).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(withoutComments).not.toMatch(/\b(rgba?|hsla?)\(/i);
  });

  it('所有容器底色都在 PALETTE 的五个容器里（装饰圆点除外）', () => {
    const offenders: string[] = [];
    for (const block of BLOCKS) {
      for (const decl of block.decls) {
        if (decl.prop !== 'background' && decl.prop !== 'background-color') continue;
        if (DECORATIVE_DOT.test(block.selector)) continue;
        const allowed = CONTAINER_VARS.some((v) => decl.value === `var(${v})`);
        if (!allowed) offenders.push(`${block.selector} { ${decl.prop}: ${decl.value} }`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('文本前景只用 --text / --text-2 / --muted（语义色不写正文）', () => {
    const offenders: string[] = [];
    for (const block of BLOCKS) {
      for (const decl of block.decls) {
        if (decl.prop !== 'color') continue;
        if (!TEXT_VARS.some((v) => decl.value === `var(${v})`))
          offenders.push(`${block.selector} { color: ${decl.value} }`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('描边与阴影也走 token', () => {
    const offenders: string[] = [];
    for (const block of BLOCKS) {
      for (const decl of block.decls) {
        if (!/^(border|border-.*color|box-shadow|outline)$/.test(decl.prop)) continue;
        const literals = decl.value.match(/#[0-9a-f]{3,8}\b|\b(rgba?|hsla?)\(/gi);
        if (literals != null) offenders.push(`${block.selector} { ${decl.prop}: ${decl.value} }`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('骨架呼吸动画只改 opacity，且尊重 prefers-reduced-motion', () => {
    expect(CSS).toContain('@keyframes ks-skel-breathe');
    expect(CSS).toContain('prefers-reduced-motion');
    const keyframeBody = /@keyframes ks-skel-breathe\s*\{[\s\S]*?\n\}/.exec(CSS)?.[0] ?? '';
    expect(keyframeBody).toContain('opacity');
    expect(keyframeBody).not.toMatch(/background|color/);
  });
});

/** 本轮真实用到的「文本前景 × 容器」组合，逐格实测。 */
const USED_PAIRS: readonly { fg: keyof typeof PALETTE.dark; bg: keyof typeof PALETTE.dark; where: string }[] = [
  { fg: 'text', bg: 'surface', where: '.ks-state__title / .ks-partial__label' },
  { fg: 'text2', bg: 'surface', where: '.ks-state__desc' },
  { fg: 'muted', bg: 'surface', where: '.ks-state__notice' },
  { fg: 'text', bg: 'surface2', where: '.ks-offline__text / banner 级 .ks-state' },
  { fg: 'text2', bg: 'surface2', where: '.ks-state__icon' },
  { fg: 'muted', bg: 'surface2', where: '.ks-partial__detail' },
  { fg: 'text2', bg: 'overlay', where: '.ks-partial__badge' },
  { fg: 'muted', bg: 'bg', where: '.ks-loading__hint（页面底）' },
  { fg: 'muted', bg: 'bg2', where: '.ks-loading__hint（bg-2 容器内）' },
];

describe('异常态文本对比度实测（WCAG AA 4.5:1）', () => {
  for (const mode of ['dark', 'light'] as ThemeMode[]) {
    for (const pair of USED_PAIRS) {
      it(`${mode}：--${pair.fg} on --${pair.bg}（${pair.where}）`, () => {
        const ratio = contrastRatio(PALETTE[mode][pair.fg], PALETTE[mode][pair.bg]);
        expect(ratio, `${mode} ${pair.fg}/${pair.bg} = ${ratio.toFixed(4)}`).toBeGreaterThanOrEqual(
          AA_NORMAL_TEXT,
        );
      });
    }
  }

  it('骨架条底色是 surface-2 落在 surface 上，条上没有任何文本', () => {
    // 骨架条不承载文字，故不参与 4.5:1 判定；这里只锁住「用的是已实测的容器」。
    expect(CSS).toContain('.ks-skel__bar');
    const bar = BLOCKS.find((b) => b.selector === '.ks-skel__bar');
    expect(bar?.decls.find((d) => d.prop === 'background')?.value).toBe('var(--surface-2)');
  });
});