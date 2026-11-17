/**
 * WCAG 2.x 对比度实测（架构 §11.5 要求「实测」而非目测）。
 * 纯函数、零依赖，可被单测与 scripts/contrast-report.ts 复用，避免两处各抄一份公式。
 */

export const AA_NORMAL_TEXT = 4.5;

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export function parseHex(hex: string): Rgb {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (m == null) throw new Error(`非法 hex 色值：${hex}`);
  const body = m[1];
  if (body == null) throw new Error(`非法 hex 色值：${hex}`);
  const full =
    body.length === 3
      ? body
          .split('')
          .map((c) => c + c)
          .join('')
      : body;
  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
  };
}

export function toHex({ r, g, b }: Rgb): string {
  const ch = (v: number) =>
    Math.min(255, Math.max(0, Math.round(v)))
      .toString(16)
      .padStart(2, '0');
  return `#${ch(r)}${ch(g)}${ch(b)}`;
}

function channelLuminance(v8: number): number {
  const c = v8 / 255;
  // WCAG 2.x 原文阈值为 0.03928（与 IEC 61966-2-1 的 0.04045 差异 <1e-5，按原文取）。
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: string): number {
  const { r, g, b } = parseHex(hex);
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

export function rgbToHsl({ r, g, b }: Rgb): { h: number; s: number; l: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return { h, s, l };
}

export function hslToRgb({ h, s, l }: { h: number; s: number; l: number }): Rgb {
  if (s === 0) {
    const v = l * 255;
    return { r: v, g: v, b: v };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t0: number) => {
    let t = t0;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return { r: hue(h + 1 / 3) * 255, g: hue(h) * 255, b: hue(h - 1 / 3) * 255 };
}

export interface ContrastFix {
  hex: string;
  ratio: number;
  /** 0 表示原值已达标，未做调整。 */
  steps: number;
}

/**
 * 保持色相与饱和度，只沿 HSL 明度轴移动，直到达标。
 * 每步都按量化后的 hex 重算比值，避免「浮点达标、落到 8bit 色值又不达标」。
 * 背景更暗则提亮前景，背景更亮则压暗前景。
 */
export function meetContrast(
  fg: string,
  bg: string,
  target: number = AA_NORMAL_TEXT,
  step = 0.002,
): ContrastFix {
  const start = contrastRatio(fg, bg);
  if (start >= target) return { hex: toHex(parseHex(fg)), ratio: start, steps: 0 };
  const dir = relativeLuminance(bg) < 0.5 ? 1 : -1;
  const hsl = rgbToHsl(parseHex(fg));
  for (let i = 1; i <= 1000; i += 1) {
    const l = hsl.l + dir * step * i;
    if (l < 0 || l > 1) break;
    const hex = toHex(hslToRgb({ ...hsl, l }));
    const ratio = contrastRatio(hex, bg);
    if (ratio >= target) return { hex, ratio, steps: i };
  }
  throw new Error(`${fg} on ${bg} 无法在明度轴上达到 ${target}:1`);
}