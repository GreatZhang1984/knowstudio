import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../src', import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.tsx?$/.test(p) ? [p] : [];
  });
}

const FILES = walk(SRC);
const rel = (p: string) => relative(SRC, p).replace(/\\/g, '/');

/** 去掉注释后再扫描：注释里提到 deriveGates 是在解释「为什么不能用」，不是调用。 */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('D-04 静态防线 · 前端不做本地闸门布尔推导', () => {
  it('扫描面非空（正则或目录走错会静默全绿）', () => {
    expect(FILES.length).toBeGreaterThan(10);
    expect(FILES.map(rel)).toContain('work/WorkGate.tsx');
    expect(FILES.map(rel)).toContain('routes/router.tsx');
  });

  it('apps/web/src 全量：没有一处 import deriveGates / checkGate / deriveGateDetails', () => {
    const forbidden = /\b(deriveGates|checkGate|deriveGateDetails|requiredGate\s*\()/;
    const offenders = FILES.filter((f) => forbidden.test(codeOf(f))).map(rel);
    expect(offenders).toEqual([]);
  });

  it('work/ 与 routes/ 只从 domain 取 resumePath，别的一概不引', () => {
    const scoped = FILES.filter((f) => /^(work|routes)\//.test(rel(f)));
    expect(scoped.length).toBeGreaterThan(0);
    const fromDomain = /from\s+'@knowstudio\/domain'/g;
    const named = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'@knowstudio\/domain'/g;
    for (const file of scoped) {
      const code = codeOf(file);
      const total = [...code.matchAll(fromDomain)].length;
      const braced = [...code.matchAll(named)];
      expect(braced.length, `${rel(file)} 有非具名的 domain import`).toBe(total);
      for (const m of braced) {
        for (const raw of (m[1] ?? '').split(',')) {
          const name = raw.trim();
          if (name.length === 0) continue;
          expect([name], `${rel(file)} 引了 ${name}`).toEqual(['resumePath']);
        }
      }
    }
  });

  it('判定闸门的那两个文件不读 envelope.gates 布尔位，只读 gateDetails', () => {
    const loader = codeOf(join(SRC, 'work/gateLoader.ts'));
    expect(loader).toContain('gateDetails');
    expect(loader).toContain('detail.satisfied');
    const gate = codeOf(join(SRC, 'work/WorkGate.tsx'));
    // 组件兜底与 loader 共用同一个判定函数，不另写一份。
    expect(gate).toContain('gateViewOf');
    for (const [name, code] of [
      ['work/gateLoader.ts', loader],
      ['work/WorkGate.tsx', gate],
    ] as const) {
      expect(/\.gates\b/.test(code), `${name} 读了 gates 布尔位`).toBe(false);
      expect(/gates\s*\[/.test(code), `${name} 下标读了 gates`).toBe(false);
    }
  });

  it('锁定态落地页只来自 detail.redirectTo，没有前端自拼的「上一门」路径', () => {
    const code = codeOf(join(SRC, 'work/gateLoader.ts'));
    expect(code).toContain('detail.redirectTo');
    expect(code).not.toContain('resumePath');
    const gate = codeOf(join(SRC, 'work/WorkGate.tsx'));
    expect(gate).toContain('view.redirectTo');
    expect(gate).not.toContain('resumePath');
  });
});

describe('G5 静态防线 · 前端侧', () => {
  it('导出成功文案只有一份，且用的是 ui 里的 G5_EXPORT_NOTICE', () => {
    const users = FILES.filter((f) => codeOf(f).includes('G5_EXPORT_NOTICE')).map(rel);
    expect(users).toContain('pages/ExportPage.tsx');
    const literal = FILES.filter((f) => codeOf(f).includes('知影不会替你自动发出去')).map(rel);
    expect(literal, '文案被抄了第二份').toEqual([]);
  });

  it('没有平台发布 SDK 的 import，也没有 publish/publisher/publishing 目录', () => {
    const sdk =
      /(weixin-js-sdk|wx-server-sdk|douyin-openapi|bilibili-api|weibo-sdk|@tencentcloud\/|@douyin\/|@bytedance\/|@bilibili\/|@xiaohongshu\/|@weibo\/)/;
    expect(FILES.filter((f) => sdk.test(codeOf(f))).map(rel)).toEqual([]);
    const dirs = new Set(FILES.map((f) => rel(f).split('/').slice(0, -1).join('/')));
    for (const dir of dirs) {
      expect(/(^|\/)(publish|publisher|publishers|publishing)(\/|$)/.test(dir), dir).toBe(false);
    }
  });

  it('没有任何指向平台发布写接口的请求', () => {
    const offenders = FILES.filter((f) =>
      /fetch\(\s*[`'"][^`'"]*\/(publish|publisher|publishing)\b/.test(codeOf(f)),
    ).map(rel);
    expect(offenders).toEqual([]);
  });
});

describe('数据访问收在 api.ts 这一层缝隙后面（T-10 落地时只换实现）', () => {
  it('除 api.ts 外没有第二处 fetch(', () => {
    const offenders = FILES.filter(
      (f) => rel(f) !== 'work/api.ts' && /\bfetch\(/.test(codeOf(f)),
    ).map(rel);
    expect(offenders).toEqual([]);
  });

  it('fixtures 只在 api.ts 的 dev 分支里动态引入，没有任何静态 import', () => {
    const importers = FILES.filter((f) => /from\s+'[^']*fixtures'/.test(codeOf(f))).map(rel);
    expect(importers).toEqual([]);
    const api = codeOf(join(SRC, 'work/api.ts'));
    expect(api).toContain("await import('./fixtures')");
    expect(api).toContain('USE_FIXTURES');
    expect(api).not.toMatch(/^import .*fixtures/m);
  });
});