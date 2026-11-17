import { describe, expect, it } from 'vitest';
import { SourceRegistry } from '../src/sources/framework.js';
import {
  buildRecordingStore,
  mapRecordedMaterial,
  normalizeKeyword,
  recordedSourceAdapters,
  RecordedSourceAdapter,
  type RecordedMaterialSeed,
} from '../src/sources/recorded.js';

const seeds: RecordedMaterialSeed[] = [
  { key: 'k1', type: 'knowledge', title: '费曼学习法', source: '知乎', license: 'cleared', bodyText: '用输出倒逼输入' },
  { key: 'k3', type: 'knowledge', title: '认知天性', source: '书籍', license: 'restricted', bodyText: '检索练习' },
  { key: 'h1', type: 'hot', title: '假装努力', source: '抖音', license: 'unknown' },
  { key: 'p1', type: 'peer', title: '同行爆款', source: 'B站', license: 'unknown' },
];

const store = buildRecordingStore([{ keyword: '费曼学习法', materials: seeds }]);

describe('normalizeKeyword（架构 §9.4 normKeyword）', () => {
  it('去空白 + 小写 + 折叠内部空白', () => {
    expect(normalizeKeyword('  费曼学习法  ')).toBe('费曼学习法');
    expect(normalizeKeyword('Feynman  Technique')).toBe('feynman technique');
  });
  it('NFKC 兼容归一（全角→半角）', () => {
    expect(normalizeKeyword('Ｆｅｙｎｍａｎ')).toBe('feynman');
  });
});

describe('mapRecordedMaterial：fixture → 冻结契约 Material', () => {
  it('映射 id/summary/url/collected，不 dump 原型字段', () => {
    const m = mapRecordedMaterial(seeds[0]!);
    expect(m).toEqual({
      id: 'mat_k1',
      type: 'knowledge',
      title: '费曼学习法',
      summary: '用输出倒逼输入',
      source: '知乎',
      url: null,
      license: 'cleared',
      collected: false,
    });
  });
  it('缺 bodyText → summary 空串；restricted 授权原样保留', () => {
    const m = mapRecordedMaterial(seeds[2]!);
    expect(m.summary).toBe('');
    expect(m.license).toBe('unknown');
    const k3 = mapRecordedMaterial(seeds[1]!);
    expect(k3.license).toBe('restricted');
  });
  it('显式 id 覆盖 → 用真实 DB id（dev 组合根注入），其余字段不变', () => {
    const dbId = 'mat_01M7938E00SRJ4ARAKGMCCFPFA';
    const m = mapRecordedMaterial({ ...seeds[0]!, id: dbId });
    expect(m.id).toBe(dbId);
    expect(m.title).toBe('费曼学习法');
    expect(m.collected).toBe(false);
  });
});

describe('RecordedSourceAdapter（D-08 / AC-D1：输入被真实读取）', () => {
  it('命中录制 → ok，按 kind 过滤', async () => {
    const a = new RecordedSourceAdapter('recorded:knowledge', 'knowledge', store);
    const r = await a.search({ keyword: '费曼学习法' }, 8000);
    expect(r.status).toBe('ok');
    expect(r.data.map((m) => m.id)).toEqual(['mat_k1', 'mat_k3']);
  });

  it('未录制关键词 → 诚实 empty，绝不回退恒定种子（D-08 核心）', async () => {
    const a = new RecordedSourceAdapter('recorded:knowledge', 'knowledge', store);
    const r = await a.search({ keyword: '量子力学' }, 8000);
    expect(r.status).toBe('empty');
    expect(r.data).toEqual([]);
    expect(r.error).toBeUndefined();
  });

  it('不同关键词命中不同录制（输入驱动，非恒定）', async () => {
    const multi = buildRecordingStore([
      { keyword: '费曼学习法', materials: seeds },
      { keyword: '番茄工作法', materials: [{ key: 't1', type: 'knowledge', title: '番茄', source: '知乎', license: 'cleared' }] },
    ]);
    const a = new RecordedSourceAdapter('recorded:knowledge', 'knowledge', multi);
    const feynman = await a.search({ keyword: '费曼学习法' }, 8000);
    const pomodoro = await a.search({ keyword: '番茄工作法' }, 8000);
    expect(feynman.data.map((m) => m.id)).toEqual(['mat_k1', 'mat_k3']);
    expect(pomodoro.data.map((m) => m.id)).toEqual(['mat_t1']);
  });

  it('规范化后命中（带空白/全角仍命中同一录制）', async () => {
    const a = new RecordedSourceAdapter('recorded:knowledge', 'knowledge', store);
    const r = await a.search({ keyword: '  费曼学习法 ' }, 8000);
    expect(r.status).toBe('ok');
  });
});

describe('recordedSourceAdapters + 框架集成', () => {
  it('三类源聚合费曼学习法 → 4 条素材（2知识+1热点+1同行）', async () => {
    const reg = new SourceRegistry();
    for (const a of recordedSourceAdapters(store)) reg.register(a);
    const agg = await reg.aggregate({ keyword: '费曼学习法' });
    expect(agg.materials.map((m) => m.id).sort()).toEqual(['mat_h1', 'mat_k1', 'mat_k3', 'mat_p1']);
    expect(agg.allFailed).toBe(false);
    expect(agg.partialErrors).toEqual([]);
  });

  it('未录制关键词 → 三列均 empty，整体空态而非故障', async () => {
    const reg = new SourceRegistry();
    for (const a of recordedSourceAdapters(store)) reg.register(a);
    const agg = await reg.aggregate({ keyword: '不存在的关键词' });
    expect(agg.materials).toEqual([]);
    expect(agg.allFailed).toBe(false);
    expect(agg.perSource.every((s) => s.status === 'empty')).toBe(true);
  });
});