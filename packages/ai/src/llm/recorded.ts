/**
 * 录制回放 LLM 适配器（dev/CI 的 VCR 口径，plan §6.1·§7.1 / 架构 §9.1·ADR-15）。
 *
 * 为什么 dev 用录制而非真实 LLM：无供应商凭证（零 env key），架构指定 dev/CI 录制回放保证确定性与零成本；
 * 真实供应商落地后实现同一 LlmPort，上层（饱和度/选题/文案）零改动即可切换。
 *
 * 守 D-08 的关键设计：
 *  - **按 task + 规范化关键词查录制**：输入被真实读取，不同关键词命中不同录制；
 *  - **未录制 → 抛 NO_RECORDING**（诚实失败，由 API 层降级为 partial），绝不回退到某个默认常量答案；
 *  - 录制数据经调用方传入的 **schema.parse 校验**后才返回，保证产出符合冻结契约（不是裸 dump fixture）。
 *
 * 边界：本包不 import seed.json（保持纯净可测）；录制 store 由组合根（apps/api）注入。
 * 通用性：blankAngles / topics / script 等任务共用本适配器，仅 task 与 store 内容不同。
 */
import type { ZodSchema } from 'zod';
import type { AiResult, LlmPort, PromptSpec } from '../ports.js';
import { normalizeKeyword } from '../sources/recorded.js';

/** 录制 store：`${task}:${规范化关键词}` → 录制原始 payload（unknown，返回前由 schema 校验）。 */
export type LlmRecordingStore = ReadonlyMap<string, unknown>;

/** 录制 key 构造（组合根建 store 与适配器查 store 必须用同一函数，避免键漂移）。 */
export function llmRecordingKey(task: string, keyword: string): string {
  return `${task}:${normalizeKeyword(keyword)}`;
}

/** LlmPort.generateStructured 的入参形状（与端口冻结一致；此处复用以便适配器实现签名）。 */
export interface RecordedLlmRequest<T> {
  task: string;
  schema: ZodSchema<T>;
  prompt: PromptSpec;
  maxTokens: number;
  timeoutMs: number;
  cacheKey?: string;
}

export class RecordedLlmAdapter implements LlmPort {
  constructor(private readonly store: LlmRecordingStore) {}

  async generateStructured<T>(req: RecordedLlmRequest<T>): Promise<AiResult<T>> {
    const start = Date.now();
    // cacheKey 由调用方传规范化关键词（见 generateBlankAngles）；缺省则空串，键仍稳定。
    const key = `${req.task}:${req.cacheKey ?? ''}`;
    const recorded = this.store.get(key);
    if (recorded === undefined) {
      // 诚实失败：未录制不等于「无角度」，更不能伪造常量答案（D-08）。API 层捕获后降级 partial。
      throw new Error(`NO_RECORDING:${key}`);
    }
    const data = req.schema.parse(recorded);
    return {
      data,
      provider: 'recorded',
      model: 'vcr-llm',
      latencyMs: Date.now() - start,
      costCny: 0,
      cacheHit: true,
    };
  }
}