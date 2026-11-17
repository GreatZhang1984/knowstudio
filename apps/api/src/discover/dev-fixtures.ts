/**
 * dev/CI 录制回放（VCR）组合根（架构 §9.1 / plan §6.1·§7.1 / M1 provider 口径）。
 *
 * 为什么 dev 用录制而非真实供应商：无知乎/抖音/LLM 凭证（零 env key），架构指定 dev/CI
 * 录制回放保证确定性与零成本；真实供应商落地后实现同一 SourceAdapter/LlmPort，本组合根换绑定即可。
 *
 * 守 D-08 的关键：录制素材 id 用**真实 DB 素材 id**（seedId('mat',key)），与库内行一致，
 * 搜索结果回填 / 收藏引用无需二次映射；空白角度依据也用同一 id，generateBlankAngles 取交集后依据非空。
 * 空白角度的 label/依据/rationale **数据驱动自种子真实选题**（t07/t08/t09），不是臆造常量。
 *
 * 边界：本文件属 apps/api 组合根，可 import @knowstudio/db 的 loadSeedData/seedId 与 @knowstudio/ai。
 */
import { loadSeedData, seedId, type SeedData } from '@knowstudio/db';
import {
  buildBlankAngleRecording,
  buildRecordingStore,
  llmRecordingKey,
  type GeneratedTopic,
  type GeneratedScriptSection,
  type BlankAngleSeed,
  type RestyleHunk,
  type LlmRecordingStore,
  type RecordedMaterialSeed,
  type RecordingStore,
} from '@knowstudio/ai';

/**
 * 把种子的空白角度标签映射到真实选题：取 angle「·」后的尾段，若被 label 包含即认定该选题是其依据来源。
 * 例：label「费曼×职场汇报」⊃ t07.angle 尾段「职场汇报」→ basis=[k1]、rationale=t07.blankPoint。
 * 找不到匹配选题 → 依据留空 + rationale 明示 [待确认]，绝不伪造依据（D-08 诚实）。
 */
export function deriveBlankAngleSeeds(seed: SeedData): BlankAngleSeed[] {
  return seed.search.blankAngles.map((label) => {
    const topic = seed.topics.find((t) => {
      const tail = t.angle.split('·').pop() ?? '';
      return tail.length > 0 && label.includes(tail);
    });
    if (topic === undefined) {
      return { label, basisKeys: [], rationale: '[待确认] 种子未提供该空白角度的依据选题' };
    }
    return { label, basisKeys: topic.basis, rationale: topic.blankPoint };
  });
}

export interface DevRecordingStores {
  readonly sourceStore: RecordingStore;
  readonly llmStore: LlmRecordingStore;
}

function topicRecordings(seed: SeedData, keyword: string): GeneratedTopic[][] {
  const primary = seed.topics.map((topic) => ({
    hook: topic.hook,
    angle: topic.angle,
    blankPoint: topic.blankPoint,
    basisMaterialIds: topic.basis.map((key) => seedId('mat', key)),
  }));
  const reroll = seed.topics.map((topic, index) => ({
    hook: `${topic.hook}（换一批 ${index + 1}）`,
    angle: `${topic.angle} · 换个证据链`,
    blankPoint: `${topic.blankPoint}（换个切入点）`,
    basisMaterialIds: topic.basis.map((key) => seedId('mat', key)),
  }));
  if (keyword === seed.search.keyword) return [primary, reroll];
  return [
    primary.map((topic) => ({ ...topic, hook: `${keyword}：${topic.hook}` })),
    reroll.map((topic) => ({ ...topic, hook: `${keyword}：${topic.hook}` })),
  ];
}

function scriptRecording(seed: SeedData, keyword: string): GeneratedScriptSection[] {
  return seed.script.sections.map((section) => ({
    kind: section.kind,
    lines: section.lines.map((line) =>
      keyword === seed.search.keyword ? line : `${keyword}：${line}`,
    ),
  }));
}

function restyleRecording(seed: SeedData): RestyleHunk[] {
  return seed.script.sections
    .flatMap((section) => section.lines)
    .slice(0, 4)
    .map((line) => ({
      original: line,
      rewritten: `说人话就是，${line.replace(/。$/, '')}。`,
    }));
}

/**
 * 由种子构建 dev 录制 store：素材源（按规范化关键词）+ 空白角度 LLM（按 task:关键词）。
 * 默认读 fixtures/seed.json；测试可注入自定义种子。
 */
export function buildDevRecordingStores(seed: SeedData = loadSeedData()): DevRecordingStores {
  const keyword = seed.search.keyword;
  const materials: RecordedMaterialSeed[] = seed.materials.map((m) => ({
    key: m.key,
    type: m.type,
    title: m.title,
    source: m.source,
    license: m.license,
    // 种子素材无 url（source_url 落库为 null）；bodyText null → undefined（契约 summary 兜空串）。
    bodyText: m.bodyText ?? undefined,
    id: seedId('mat', m.key),
  }));
  const sourceStore = buildRecordingStore([{ keyword, materials }]);

  const llmEntries: [string, unknown][] = [
    [
      llmRecordingKey('blankAngles', keyword),
      buildBlankAngleRecording(keyword, deriveBlankAngleSeeds(seed), (key) => seedId('mat', key)),
    ],
  ];
  for (const [index, topics] of topicRecordings(seed, keyword).entries()) {
    llmEntries.push([llmRecordingKey('topics', `${keyword}:${index}`), topics]);
  }
  llmEntries.push([llmRecordingKey('script', keyword), scriptRecording(seed, keyword)]);
  llmEntries.push([llmRecordingKey('restyle', ''), restyleRecording(seed)]);
  const llmStore: LlmRecordingStore = new Map(llmEntries);

  return { sourceStore, llmStore };
}
