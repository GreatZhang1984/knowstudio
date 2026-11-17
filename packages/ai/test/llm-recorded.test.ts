import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { BlankAngleSchema } from '@knowstudio/contracts';
import { RecordedLlmAdapter, llmRecordingKey, type LlmRecordingStore } from '../src/llm/recorded.js';

const AnglesSchema = z.array(BlankAngleSchema).min(2);

function angle(id: string, basis: string[]) {
  return { id, label: `角度-${id}`, basisMaterialIds: basis, rationale: '依据说明' };
}

function store(entries: [string, unknown][]): LlmRecordingStore {
  return new Map(entries);
}

const req = (task: string, cacheKey: string) => ({
  task,
  schema: AnglesSchema,
  prompt: { user: 'u' },
  maxTokens: 100,
  timeoutMs: 1000,
  cacheKey,
});

describe('llmRecordingKey：task + 规范化关键词', () => {
  it('去空白 / 小写 / NFKC 归一，与素材录制同一规范化口径', () => {
    expect(llmRecordingKey('blankAngles', '  费曼学习法 ')).toBe('blankAngles:费曼学习法');
    expect(llmRecordingKey('blankAngles', 'Ｆｅｙｎｍａｎ')).toBe('blankAngles:feynman');
  });
});

describe('RecordedLlmAdapter：录制回放（dev VCR）', () => {
  it('命中录制 → schema.parse 校验后返回 AiResult（provider recorded / cost 0 / cacheHit）', async () => {
    const data = [angle('ba_0', ['mat_k1']), angle('ba_1', ['mat_h1'])];
    const llm = new RecordedLlmAdapter(store([[llmRecordingKey('blankAngles', '费曼学习法'), data]]));
    const res = await llm.generateStructured(req('blankAngles', '费曼学习法'));
    expect(res.data).toEqual(data);
    expect(res.provider).toBe('recorded');
    expect(res.model).toBe('vcr-llm');
    expect(res.costCny).toBe(0);
    expect(res.cacheHit).toBe(true);
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('未录制 → 抛 NO_RECORDING（诚实失败，绝不伪造常量答案，D-08）', async () => {
    const llm = new RecordedLlmAdapter(store([]));
    await expect(llm.generateStructured(req('blankAngles', '冷门关键词'))).rejects.toThrow(
      'NO_RECORDING:blankAngles:冷门关键词',
    );
  });

  it('不同关键词命中不同录制（输入被真实读取）', async () => {
    const a = [angle('ba_a0', ['mat_k1']), angle('ba_a1', ['mat_k2'])];
    const b = [angle('ba_b0', ['mat_p1']), angle('ba_b1', ['mat_p2'])];
    const llm = new RecordedLlmAdapter(
      store([
        [llmRecordingKey('blankAngles', '费曼学习法'), a],
        [llmRecordingKey('blankAngles', '卡片笔记'), b],
      ]),
    );
    expect((await llm.generateStructured(req('blankAngles', '费曼学习法'))).data).toEqual(a);
    expect((await llm.generateStructured(req('blankAngles', '卡片笔记'))).data).toEqual(b);
  });

  it('录制不符 schema（缺 rationale）→ parse 抛错，不返回脏数据', async () => {
    const bad = [{ id: 'ba_0', label: 'x', basisMaterialIds: [] }, angle('ba_1', [])];
    const llm = new RecordedLlmAdapter(store([[llmRecordingKey('blankAngles', 'k'), bad]]));
    await expect(llm.generateStructured(req('blankAngles', 'k'))).rejects.toThrow();
  });

  it('录制只有 1 个角度 → min(2) 校验拒绝（AC-D2 ≥2）', async () => {
    const llm = new RecordedLlmAdapter(store([[llmRecordingKey('blankAngles', 'k'), [angle('ba_0', [])]]]));
    await expect(llm.generateStructured(req('blankAngles', 'k'))).rejects.toThrow();
  });

  it('task 隔离：同关键词不同 task 不串录制', async () => {
    const llm = new RecordedLlmAdapter(
      store([[llmRecordingKey('blankAngles', 'k'), [angle('ba_0', []), angle('ba_1', [])]]]),
    );
    await expect(llm.generateStructured(req('topics', 'k'))).rejects.toThrow('NO_RECORDING:topics:k');
  });
});