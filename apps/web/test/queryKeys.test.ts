import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { invalidateWork, workKeys } from '../src/work/queries';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const PROBE_ID = 'w_probe';

/**
 * 允许不带 workId 的全局 key：它们本来就与作品无关。
 * 这份名单是**封闭**的——新增全局 key 必须先在这里登记，否则用例失败。
 */
const GLOBAL_CONSTANT_NAMES = ['materialSources', 'metrics', 'platformRules', 'quota', 'recent'];
const GLOBAL_BUILDER_NAMES = ['ledger', 'library', 'styleProfile', 'styleSamples'];

type UnknownBuilder = (...args: unknown[]) => readonly unknown[];

const entries = Object.entries(workKeys) as [string, unknown][];
const builders = entries.filter((e): e is [string, UnknownBuilder] => typeof e[1] === 'function');
const constants = entries.filter((e) => Array.isArray(e[1])) as [string, readonly unknown[]][];
const scopedBuilders = builders.filter(([name]) => !GLOBAL_BUILDER_NAMES.includes(name));

/** 按形参个数自动补参：第 0 位是 workId，其余给个占位值，不手工维护清单。 */
function keyOf(fn: UnknownBuilder, workId: string): readonly unknown[] {
  const args = Array.from({ length: fn.length }, (_, i) => (i === 0 ? workId : i));
  return fn(...args);
}

describe('架构 §11.2 · queryKey 规范（遍历断言，不是抽查）', () => {
  it('workKeys 里既有 builder 也有常量，遍历样本非空', () => {
    expect(builders.length).toBeGreaterThan(0);
    expect(builders.length + constants.length).toBe(entries.length);
  });

  it('全局 key 白名单封闭，没有偷偷新增的跨 work 缓存', () => {
    expect(constants.map(([name]) => name).sort()).toEqual([...GLOBAL_CONSTANT_NAMES].sort());
    expect(builders.map(([name]) => name)).toEqual(expect.arrayContaining(GLOBAL_BUILDER_NAMES));
  });

  it('每一个 work 范围的 key 都含 workId，且 workId 固定在第 1 位', () => {
    for (const [name, fn] of scopedBuilders) {
      const key = keyOf(fn, PROBE_ID);
      expect(key, `${name} 的 key 不含 workId`).toContain(PROBE_ID);
      expect(key[0], `${name} 的 key 前缀不是 work`).toBe('work');
      expect(key[1], `${name} 的 workId 不在第 1 位`).toBe(PROBE_ID);
    }
  });

  it('换一个 workId，每一个 key 都跟着变（不存在两个 Work 撞同一把 key）', () => {
    for (const [name, fn] of scopedBuilders) {
      expect(keyOf(fn, 'wA'), name).not.toEqual(keyOf(fn, 'wB'));
    }
  });

  it('每个 work 范围的 key 都以信封 key 为前缀：一次 invalidate 精确清一个 Work', () => {
    for (const [name, fn] of scopedBuilders) {
      const key = keyOf(fn, PROBE_ID);
      const prefix = workKeys.envelope(PROBE_ID);
      expect(key.slice(0, prefix.length), name).toEqual([...prefix]);
    }
  });

  it('三处额度同源：quota 只有一把 key（AC-H3）', () => {
    const quotaLike = entries.filter(([name]) => name.toLowerCase().includes('quota'));
    expect(quotaLike.map(([name]) => name)).toEqual(['quota']);
    expect(workKeys.quota).toEqual(['quota']);
  });
});

describe('invalidateWork 只清这一个 Work', () => {
  it('wA 的全部缓存失效，wB 与全局 quota 不受影响', async () => {
    const qc = new QueryClient();
    const aKeys = [
      workKeys.envelope('wA'),
      workKeys.script('wA'),
      workKeys.topics('wA', 0),
      workKeys.derivatives('wA'),
      workKeys.derivative('wA', 'douyin'),
      workKeys.job('wA', 'job_1'),
      workKeys.search('wA', 'ss_1'),
    ];
    const bKeys = [workKeys.envelope('wB'), workKeys.script('wB'), workKeys.job('wB', 'job_1')];
    const libraryKey = workKeys.library('', undefined, undefined);
    const styleKey = workKeys.styleSamples();
    for (const key of [...aKeys, ...bKeys, libraryKey, styleKey, workKeys.quota, workKeys.recent]) {
      qc.setQueryData(key, { ok: true });
    }

    await invalidateWork(qc, 'wA');

    for (const key of aKeys)
      expect(qc.getQueryState(key)?.isInvalidated, JSON.stringify(key)).toBe(true);
    for (const key of [...bKeys, libraryKey, styleKey, workKeys.quota, workKeys.recent]) {
      expect(qc.getQueryState(key)?.isInvalidated, JSON.stringify(key)).toBe(false);
    }
    // 同一个 jobId 挂在不同 Work 下也是两条缓存，不会串台。
    expect(qc.getQueryData(workKeys.job('wB', 'job_1'))).toEqual({ ok: true });
  });
});

describe('源码扫描：没有绕过 workKeys 的裸 queryKey', () => {
  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) return walk(p);
      return /\.tsx?$/.test(p) ? [p] : [];
    });
  }

  it('apps/web/src 下每一处 queryKey 都取自 workKeys', () => {
    const offenders: string[] = [];
    let checked = 0;
    for (const file of walk(SRC)) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/queryKey:\s*([^\n,]+)/g)) {
        checked += 1;
        const expr = m[1] ?? '';
        if (!expr.startsWith('workKeys.')) offenders.push(`${file}: ${expr}`);
      }
    }
    expect(checked, '一处都没扫到说明正则失效了').toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });
});
