import { describe, expect, it, vi } from 'vitest';
import type { Material } from '@knowstudio/contracts';
import type { PartialResult, SourceAdapter, SourceKind, SourceQuery } from '../src/ports.js';
import { CIRCUIT_OPEN_MS, SourceRegistry, type Clock } from '../src/sources/framework.js';

function material(id: string, type: Material['type'] = 'knowledge'): Material {
  return {
    id,
    type,
    title: `t-${id}`,
    summary: 's',
    source: '知乎',
    url: null,
    license: 'cleared',
    collected: false,
  };
}

function ok(data: Material[], latencyMs = 1): PartialResult<Material[]> {
  return { status: 'ok', data, latencyMs };
}

function adapter(
  id: string,
  kind: SourceKind,
  search: (q: SourceQuery, budgetMs: number) => Promise<PartialResult<Material[]>>,
): SourceAdapter {
  return { id, sourceId: id.startsWith('web:') ? 'web_search' : 'recorded', kind, search };
}

const q: SourceQuery = { keyword: '费曼学习法' };

describe('SourceRegistry 编排（T-17）', () => {
  it('并行聚合三类源并按 id 去重', async () => {
    const reg = new SourceRegistry();
    reg.register(adapter('k', 'knowledge', async () => ok([material('m1'), material('m2')])));
    reg.register(adapter('h', 'hot', async () => ok([material('m3', 'hot')])));
    // 与知识源重复的 m1：跨源去重后只保留一条。
    reg.register(
      adapter('p', 'peer', async () => ok([material('m1', 'peer'), material('m4', 'peer')])),
    );

    const agg = await reg.aggregate(q);
    expect(agg.materials.map((m) => m.id).sort()).toEqual(['m1', 'm2', 'm3', 'm4']);
    expect(agg.allFailed).toBe(false);
    expect(agg.partialErrors).toEqual([]);
    expect(agg.perSource).toHaveLength(3);
    expect(agg.perSource.every((s) => s.status === 'ok')).toBe(true);
  });

  it('按源类别切分超时预算（知识8s/热点6s/同行6s）', async () => {
    const seen: Record<string, number> = {};
    const reg = new SourceRegistry();
    for (const kind of ['knowledge', 'hot', 'peer'] as const) {
      reg.register(
        adapter(kind, kind, async (_q, budgetMs) => {
          seen[kind] = budgetMs;
          return ok([]);
        }),
      );
    }
    await reg.aggregate(q);
    expect(seen).toEqual({ knowledge: 8000, hot: 6000, peer: 6000 });
  });

  it('T-64：按用户选择的素材源过滤适配器，未选源不发起请求', async () => {
    const calls: string[] = [];
    const reg = new SourceRegistry();
    reg.register(
      adapter('recorded:knowledge', 'knowledge', async () => {
        calls.push('recorded');
        return ok([material('m1')]);
      }),
    );
    reg.register({
      id: 'web:tavily',
      sourceId: 'web_search',
      kind: 'knowledge',
      search: async () => {
        calls.push('web');
        return ok([material('m2')]);
      },
    });

    const agg = await reg.aggregate(q, { sourceIds: ['web_search'] });
    expect(calls).toEqual(['web']);
    expect(agg.materials.map((m) => m.id)).toEqual(['m2']);
  });

  it('单源超时 → 该列 error，其余列正常，allFailed=false（AC-D1 partial）', async () => {
    const reg = new SourceRegistry();
    reg.register(adapter('k', 'knowledge', async () => ok([material('m1')])));
    reg.register(
      adapter(
        'h',
        'hot',
        () => new Promise((resolve) => setTimeout(() => resolve(ok([material('m2', 'hot')])), 50)),
      ),
    );
    const agg = await reg.aggregate(q, { budgetMs: { hot: 10 } });

    expect(agg.materials.map((m) => m.id)).toEqual(['m1']);
    expect(agg.allFailed).toBe(false);
    expect(agg.partialErrors).toHaveLength(1);
    expect(agg.partialErrors[0]?.source).toBe('h');
    expect(agg.partialErrors[0]?.code).toBe('SOURCE_TIMEOUT');
    const hot = agg.perSource.find((s) => s.id === 'h');
    expect(hot?.status).toBe('error');
  });

  it('单源 reject → SOURCE_FAILED，不阻塞整体', async () => {
    const reg = new SourceRegistry();
    reg.register(adapter('k', 'knowledge', async () => ok([material('m1')])));
    reg.register(
      adapter('h', 'hot', async () => {
        throw new Error('boom');
      }),
    );
    const agg = await reg.aggregate(q);
    expect(agg.materials.map((m) => m.id)).toEqual(['m1']);
    expect(agg.partialErrors[0]?.code).toBe('SOURCE_FAILED');
    expect(agg.allFailed).toBe(false);
  });

  it('全部源失败 → allFailed=true（架构 §9.3 聚合失败可手动导入）', async () => {
    const reg = new SourceRegistry();
    reg.register(
      adapter('k', 'knowledge', async () => ({
        status: 'error',
        data: [],
        error: { code: 'X', message: 'x' },
        latencyMs: 0,
      })),
    );
    reg.register(
      adapter('h', 'hot', async () => ({
        status: 'error',
        data: [],
        error: { code: 'Y', message: 'y' },
        latencyMs: 0,
      })),
    );
    const agg = await reg.aggregate(q);
    expect(agg.allFailed).toBe(true);
    expect(agg.materials).toEqual([]);
    expect(agg.partialErrors).toHaveLength(2);
  });

  it('empty ≠ error：源健康但无命中是空态，不进 partialErrors', async () => {
    const reg = new SourceRegistry();
    reg.register(
      adapter('k', 'knowledge', async () => ({ status: 'empty', data: [], latencyMs: 1 })),
    );
    const agg = await reg.aggregate(q);
    expect(agg.allFailed).toBe(false);
    expect(agg.partialErrors).toEqual([]);
    expect(agg.perSource[0]?.status).toBe('empty');
  });

  it('无适配器 → 空态而非 allFailed', async () => {
    const reg = new SourceRegistry();
    const agg = await reg.aggregate(q);
    expect(agg.materials).toEqual([]);
    expect(agg.allFailed).toBe(false);
  });

  it('重复 id 注册被拒', () => {
    const reg = new SourceRegistry();
    reg.register(adapter('k', 'knowledge', async () => ok([])));
    expect(() => reg.register(adapter('k', 'hot', async () => ok([])))).toThrow(/重复注册/);
  });
});

describe('SourceRegistry 熔断（架构 §9.2：连续5次失败开60s）', () => {
  it('连续5次失败后第6次短路 CIRCUIT_OPEN，不再调用适配器', async () => {
    const now = 1000;
    const clock: Clock = { now: () => now };
    const search = vi.fn(async () => ({
      status: 'error' as const,
      data: [],
      error: { code: 'X', message: 'x' },
      latencyMs: 0,
    }));
    const reg = new SourceRegistry(clock);
    reg.register(adapter('k', 'knowledge', search));

    for (let i = 0; i < 5; i += 1) await reg.aggregate(q);
    expect(search).toHaveBeenCalledTimes(5);

    const sixth = await reg.aggregate(q);
    expect(search).toHaveBeenCalledTimes(5); // 第6次被熔断短路，未真调
    expect(sixth.partialErrors[0]?.code).toBe('CIRCUIT_OPEN');
    expect(sixth.allFailed).toBe(true);
  });

  it('熔断60s后半开：成功一次即闭路', async () => {
    let now = 1000;
    const clock: Clock = { now: () => now };
    let calls = 0;
    const search = vi.fn(async () => {
      calls += 1;
      // 前5次失败触发熔断；半开那次（第6次真调）成功。
      return calls <= 5
        ? { status: 'error' as const, data: [], error: { code: 'X', message: 'x' }, latencyMs: 0 }
        : ok([material('m1')]);
    });
    const reg = new SourceRegistry(clock);
    reg.register(adapter('k', 'knowledge', search));

    for (let i = 0; i < 5; i += 1) await reg.aggregate(q);
    now += CIRCUIT_OPEN_MS; //  advancing past 熔断窗口 → 半开
    const recovered = await reg.aggregate(q);
    expect(search).toHaveBeenCalledTimes(6);
    expect(recovered.materials.map((m) => m.id)).toEqual(['m1']);
    expect(recovered.allFailed).toBe(false);

    // 闭路后再调仍真调（计数继续增长）。
    await reg.aggregate(q);
    expect(search).toHaveBeenCalledTimes(7);
  });
});
