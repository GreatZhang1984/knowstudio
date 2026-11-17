import { describe, expect, it } from 'vitest';
import { BlankAngleSchema, type BlankAngle, type Material } from '@knowstudio/contracts';
import type { LlmPort } from '../src/ports.js';
import {
  buildBlankAngleRecording,
  generateBlankAngles,
  type BlankAngleSeed,
} from '../src/saturation/blank-angles.js';
import { RecordedLlmAdapter, llmRecordingKey, type RecordedLlmRequest } from '../src/llm/recorded.js';
import { mapRecordedMaterial } from '../src/sources/recorded.js';

function angle(id: string, basis: string[]): BlankAngle {
  return { id, label: `角度-${id}`, basisMaterialIds: basis, rationale: '依据' };
}

/** 假 LLM：返回固定角度，可选捕获入参；类型按 BlankAngle[] 特化后 cast 到 LlmPort（测试用）。 */
function fakeLlm(data: BlankAngle[], capture?: (req: RecordedLlmRequest<BlankAngle[]>) => void): LlmPort {
  const impl = {
    async generateStructured(req: RecordedLlmRequest<BlankAngle[]>) {
      capture?.(req);
      return { data, provider: 'fake', model: 'm', latencyMs: 1, costCny: 0, cacheHit: false };
    },
  };
  return impl as unknown as LlmPort;
}

function throwingLlm(message: string): LlmPort {
  const impl = {
    async generateStructured() {
      throw new Error(message);
    },
  };
  return impl as unknown as LlmPort;
}

const materials: Material[] = [
  mapRecordedMaterial({ key: 'k1', type: 'knowledge', title: '费曼', source: '知乎', license: 'cleared' }),
  mapRecordedMaterial({ key: 'h1', type: 'hot', title: '假装努力', source: '抖音', license: 'unknown' }),
  mapRecordedMaterial({ key: 'p1', type: 'peer', title: '三分钟讲透', source: '抖音', license: 'unknown' }),
];

describe('generateBlankAngles：依据防悬空（D-08 诚实）', () => {
  it('basisMaterialIds 与真实素材取交集，剔除幻觉/漂移引用', async () => {
    const llm = fakeLlm([
      angle('ba_0', ['mat_k1', 'mat_GHOST']),
      angle('ba_1', ['mat_h1']),
    ]);
    const res = await generateBlankAngles({ keyword: '费曼学习法', materials }, llm);
    expect(res.data[0]!.basisMaterialIds).toEqual(['mat_k1']); // mat_GHOST 被剔除
    expect(res.data[1]!.basisMaterialIds).toEqual(['mat_h1']);
    expect(res.provider).toBe('fake'); // AiResult 透传，供 ai_call_log
  });

  it('全部依据都悬空 → 该角度 basisMaterialIds 为空（不伪造依据）', async () => {
    const llm = fakeLlm([angle('ba_0', ['mat_X']), angle('ba_1', ['mat_Y'])]);
    const res = await generateBlankAngles({ keyword: 'k', materials }, llm);
    expect(res.data.every((a) => a.basisMaterialIds.length === 0)).toBe(true);
  });

  it('传 task=blankAngles + cacheKey=规范化关键词 + schema（≥2）', async () => {
    let captured: RecordedLlmRequest<BlankAngle[]> | undefined;
    const llm = fakeLlm([angle('ba_0', ['mat_k1']), angle('ba_1', ['mat_h1'])], (r) => {
      captured = r;
    });
    await generateBlankAngles({ keyword: '  费曼学习法 ', domain: '学习方法', materials }, llm);
    expect(captured?.task).toBe('blankAngles');
    expect(captured?.cacheKey).toBe('费曼学习法');
    expect(captured?.prompt.user).toContain('费曼学习法');
    expect(captured?.prompt.user).toContain('学习方法');
    expect(captured?.prompt.user).toContain('mat_k1'); // 真实素材 id 注入 prompt
    // schema 拒绝 <2
    expect(() => captured!.schema.parse([angle('ba_0', [])])).toThrow();
  });

  it('LLM 失败/未录制 → 向上抛错（由 API 层降级 partial，不在此吞错）', async () => {
    await expect(
      generateBlankAngles({ keyword: 'k', materials }, throwingLlm('NO_RECORDING:blankAngles:k')),
    ).rejects.toThrow('NO_RECORDING');
  });
});

describe('buildBlankAngleRecording：种子 → 契约录制 payload', () => {
  const seeds: BlankAngleSeed[] = [
    { label: '费曼×职场汇报', basisKeys: ['k1', 'p1'], rationale: '职场应用空白' },
    { label: '费曼×假装努力', basisKeys: ['h1'], rationale: '热点结合' },
  ];

  it('id ≤36 且符合 PrefixedId，basisMaterialIds 映射到 mat_<key>', () => {
    const rec = buildBlankAngleRecording('费曼学习法', seeds);
    expect(rec).toHaveLength(2);
    for (const a of rec) {
      expect(() => BlankAngleSchema.parse(a)).not.toThrow();
      expect(a.id.length).toBeLessThanOrEqual(36);
    }
    expect(rec[0]!.basisMaterialIds).toEqual(['mat_k1', 'mat_p1']);
    expect(rec[0]!.label).toBe('费曼×职场汇报');
    expect(rec[1]!.basisMaterialIds).toEqual(['mat_h1']);
  });

  it('id 确定性：同关键词同序号 → 同 id（缓存稳定）', () => {
    expect(buildBlankAngleRecording('费曼学习法', seeds)[0]!.id).toBe(
      buildBlankAngleRecording('费曼学习法', seeds)[0]!.id,
    );
  });
});

describe('端到端：录制 LLM + 真实素材 → 空白角度（dev VCR 全链路）', () => {
  it('依据全部命中真实聚合素材，≥2 角度，provider recorded', async () => {
    const seeds: BlankAngleSeed[] = [
      { label: '费曼×职场汇报', basisKeys: ['k1', 'p1'], rationale: '同行多讲学习方法本身，职场应用空白' },
      { label: '费曼×「假装努力」热点', basisKeys: ['h1'], rationale: '热点×方法论结合未讲透' },
      { label: '费曼×卡片笔记', basisKeys: ['k1'], rationale: '工具落地角度' },
    ];
    const store = new Map([
      [llmRecordingKey('blankAngles', '费曼学习法'), buildBlankAngleRecording('费曼学习法', seeds)],
    ]);
    const llm = new RecordedLlmAdapter(store);
    const res = await generateBlankAngles({ keyword: '费曼学习法', materials }, llm);

    expect(res.data.length).toBeGreaterThanOrEqual(2);
    expect(res.provider).toBe('recorded');
    const realIds = new Set(materials.map((m) => m.id));
    for (const a of res.data) {
      expect(a.basisMaterialIds.length).toBeGreaterThan(0);
      expect(a.basisMaterialIds.every((id) => realIds.has(id))).toBe(true);
    }
  });

  it('未录制关键词 → 抛 NO_RECORDING（不返回常量角度，D-08）', async () => {
    const llm = new RecordedLlmAdapter(new Map());
    await expect(generateBlankAngles({ keyword: '冷门词', materials }, llm)).rejects.toThrow('NO_RECORDING');
  });
});