import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PALETTE, STAGES } from '../src/tokens';
import type { Palette, ThemeMode } from '../src/tokens';

const css = readFileSync(new URL('../src/tokens.css', import.meta.url), 'utf8');

function declarations(selector: RegExp): Map<string, string> {
  const body = selector.exec(css)?.[1];
  if (body == null) throw new Error(`tokens.css 缺少选择器 ${String(selector)}`);
  const out = new Map<string, string>();
  for (const m of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    const name = m[1];
    const value = m[2];
    if (name != null && value != null) out.set(name, value.trim());
  }
  return out;
}

const root = declarations(/:root\s*\{([\s\S]*?)\}/);
const light = new Map([...root, ...declarations(/\[data-theme='light'\]\s*\{([\s\S]*?)\}/)]);
const BY_MODE: Record<ThemeMode, Map<string, string>> = { dark: root, light };

const CSS_NAME: Record<keyof Palette, string> = {
  bg: '--bg',
  bg2: '--bg-2',
  surface: '--surface',
  surface2: '--surface-2',
  overlay: '--overlay',
  line: '--line',
  text: '--text',
  text2: '--text-2',
  muted: '--muted',
};

describe('tokens.css 与 tokens.ts 不漂移', () => {
  for (const mode of ['dark', 'light'] as const satisfies readonly ThemeMode[]) {
    for (const key of Object.keys(CSS_NAME) as (keyof Palette)[]) {
      it(`${mode} ${CSS_NAME[key]}`, () => {
        expect(BY_MODE[mode].get(CSS_NAME[key])).toBe(PALETTE[mode][key]);
      });
    }
    for (const stage of STAGES) {
      it(`${mode} --${stage.token} / --${stage.token}-dim`, () => {
        expect(BY_MODE[mode].get(`--${stage.token}`)).toBe(stage.color);
        expect(BY_MODE[mode].get(`--${stage.token}-dim`)).toBe(stage.dim[mode]);
      });
    }
  }

  it('侧边栏宽度为 SPEC §2.4 的 250px', () => {
    expect(root.get('--sidebar-w')).toBe('250px');
  });
});