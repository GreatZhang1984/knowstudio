import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { matchPath } from 'react-router-dom';
import { WorkStep } from '@knowstudio/contracts';
import { resumePath } from '@knowstudio/domain';
import { NAV_ITEMS, PAGE_ROUTES, REDIRECT_ROUTES, ROUTES } from '../src/routes/manifest';

/** SPEC §2.5 路由表的 18 行，[id] 写成 React Router 的 :id。 */
const SPEC_PAGES: readonly [string, string][] = [
  ['page-home', '/'],
  ['page-works', '/works'],
  ['page-work-detail', '/works/:id'],
  ['page-discover', '/discover'],
  ['page-trends', '/discover/trends'],
  ['page-topics', '/discover/topics'],
  ['page-script', '/studio/:id/script'],
  ['page-video', '/studio/:id/video'],
  ['page-render', '/studio/:id/render'],
  ['page-publish', '/publish/:id'],
  ['page-export', '/publish/:id/export'],
  ['page-library', '/library'],
  ['page-library-detail', '/library/:id'],
  ['page-settings', '/settings'],
  ['page-settings-style', '/settings/style'],
  ['page-settings-quota', '/settings/quota'],
  ['page-login', '/login'],
  ['page-welcome', '/welcome'],
];

describe('路由表与 SPEC §2.5 逐行一致', () => {
  it('20 行 = 18 页 + 2 个域入口重定向', () => {
    expect(ROUTES).toHaveLength(20);
    expect(PAGE_ROUTES).toHaveLength(18);
    expect(REDIRECT_ROUTES.map((r) => r.path)).toEqual(['/studio', '/publish']);
  });

  it('pageId 与 path 一一对应，无多无缺', () => {
    expect(PAGE_ROUTES.map((r) => [r.pageId, r.path])).toEqual(SPEC_PAGES.map((p) => [...p]));
  });

  it('path 与 pageId 均不重复', () => {
    expect(new Set(PAGE_ROUTES.map((r) => r.path)).size).toBe(18);
    expect(new Set(PAGE_ROUTES.map((r) => r.pageId)).size).toBe(18);
  });

  it('主导航 6 项且不超过 7（SPEC §2.5）', () => {
    expect(NAV_ITEMS).toHaveLength(6);
    expect(NAV_ITEMS.length).toBeLessThanOrEqual(7);
    for (const item of NAV_ITEMS) {
      expect(ROUTES.some((r) => r.path === item.to)).toBe(true);
    }
  });
});

describe('懒加载', () => {
  it('18 页全部是 React.lazy 组件', () => {
    for (const route of PAGE_ROUTES) {
      expect(route.component.$$typeof, route.path).toBe(Symbol.for('react.lazy'));
    }
  });

  it('每页各自一个模块文件（chunk 边界真实存在）', () => {
    const source = readFileSync(new URL('../src/routes/manifest.ts', import.meta.url), 'utf8');
    const specifiers = [...source.matchAll(/import\('(\.\.\/pages\/[^']+)'\)/g)].map((m) => m[1]);
    expect(specifiers).toHaveLength(18);
    expect(new Set(specifiers).size).toBe(18);
    for (const spec of specifiers) {
      const file = new URL(`${spec}.tsx`, new URL('../src/routes/manifest.ts', import.meta.url));
      expect(existsSync(file), String(spec)).toBe(true);
    }
  });
});

describe('门与外壳（架构 §11.1）', () => {
  it('只有 video/render/publish 挂 G2、export 挂 G4', () => {
    const gated = PAGE_ROUTES.filter((r) => r.gate != null).map((r) => [r.path, r.gate]);
    expect(gated).toEqual([
      ['/studio/:id/video', 'G2'],
      ['/studio/:id/render', 'G2'],
      ['/publish/:id', 'G2'],
      ['/publish/:id/export', 'G4'],
    ]);
  });

  it('登录与引导不套工作台外壳', () => {
    expect(PAGE_ROUTES.filter((r) => r.shell === 'bare').map((r) => r.path)).toEqual([
      '/login',
      '/welcome',
    ]);
  });
});

describe('SPEC §2.2 的 9 个续作落地页全部可达', () => {
  for (const step of WorkStep.values) {
    it(`${step} → ${resumePath(step, 'w1')}`, () => {
      const target = resumePath(step, 'w1');
      expect(PAGE_ROUTES.some((r) => matchPath({ path: r.path, end: true }, target) != null)).toBe(
        true,
      );
    });
  }
});