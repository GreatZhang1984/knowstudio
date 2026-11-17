/**
 * 饱和度算法（T-19 / SPEC §3.2·§6.1 / 架构 §9·R2）。
 *
 * 饱和度 = 某知识点在全网的同质化程度（0–100，SPEC §13 术语表），越高＝讲的人越多。
 *
 * ⚠️ [待确认] score 公式 SPEC/架构均**未规定**（只给了分档 0–40/41–70/71–100 与
 * 「必须带置信度/样本量/来源」）。这里用一条**可测、输入驱动**的 [推断] 加权密度饱和曲线：
 *   weighted = nPeer·3 + nHot·2 + nKnowledge·1   （同行爆款＞热点＞知识：直接竞争＞趋势＞书面知识）
 *   score    = round(100 · weighted / (weighted + HALF_SATURATION))
 * 它是占位推导，待产品裁决（task #16），**绝不回退为常量 72**——D-08 正是把「饱和度恒 72%」列为缺陷。
 * 不同关键词聚合出不同素材 → 不同分数；无素材 → score 0（由 sufficient=false 标记「数据不足」）。
 *
 * 纯函数、零 IO：只依赖 contracts 类型，可在 ai 包内直接单测，不经 LLM/网络。
 */
import type { Material, PlatformId, Saturation } from '@knowstudio/contracts';

/**
 * source → PlatformId 映射 [推断]。只有四视频平台可映射；
 * 知乎/公众号/书籍/微博是知识或热点来源但**不是** douyin/sph/bili/xhs，故进 sources 不进 coveredPlatforms。
 * 与 fixture 的 coveredPlatforms=[douyin,bili,xhs] 一致（微博/知乎/公众号/书籍被排除）。
 */
const SOURCE_PLATFORM: Readonly<Record<string, PlatformId>> = {
  抖音: 'douyin',
  B站: 'bili',
  小红书: 'xhs',
  视频号: 'sph',
};

/** coveredPlatforms 的稳定排序（按 PlatformId 枚举序），保证缓存相等性与输入顺序无关。 */
const PLATFORM_ORDER: readonly PlatformId[] = ['douyin', 'sph', 'bili', 'xhs'];

/**
 * 全部 [待确认] 可调参数，集中一处便于裁决后改动。
 *  - weight/halfSaturation：score 曲线形状（[推断]，见文件头）。
 *  - confidentSampleSize/confidentPlatformCount：confidence 双因子满刻度（平台数 4 = PlatformId 全集，有依据）。
 *  - minSampleSize/sufficientConfidence：sufficient 判据（confidence 阈值 0.5 锚定 plan TR-3「平均 confidence<0.5」风险信号）。
 */
export const SATURATION_TUNING = {
  weight: { peer: 3, hot: 2, knowledge: 1 },
  halfSaturation: 12,
  confidentSampleSize: 10,
  confidentPlatformCount: 4,
  minSampleSize: 5,
  sufficientConfidence: 0.5,
} as const;

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
const round2 = (x: number): number => Math.round(x * 100) / 100;

/** SPEC §3.2 分档：0–40 蓝海 / 41–70 有空间 / 71–100 讲的人很多。 */
export function saturationLevel(score: number): Saturation['level'] {
  if (score <= 40) return 'blue_ocean';
  if (score <= 70) return 'has_room';
  return 'saturated';
}

/** 聚合素材里出现过的视频平台（去重 + 枚举序排序）。非平台来源（知乎/微博等）被忽略。 */
export function coveredPlatformsOf(materials: readonly Material[]): PlatformId[] {
  const found = new Set<PlatformId>();
  for (const m of materials) {
    const p = SOURCE_PLATFORM[m.source];
    if (p) found.add(p);
  }
  return PLATFORM_ORDER.filter((p) => found.has(p));
}

/**
 * 从真实聚合素材计算饱和度。always 返回契约合法 Saturation（score 0–100、confidence 0–1）。
 * 样本不足时 sufficient=false + confidence 低，由 UI 灰化仪表并显示「数据不足，仅供参考」（AC-D5）。
 * 全失败/空聚合时本函数仍返回 score 0 的合法值；是否挂载 saturation（还是 null）由 API 层按聚合状态决定（T-20）。
 */
export function computeSaturation(materials: readonly Material[]): Saturation {
  const t = SATURATION_TUNING;
  const sampleSize = materials.length;

  let nPeer = 0;
  let nHot = 0;
  let nKnowledge = 0;
  const sourceSet = new Set<string>();
  for (const m of materials) {
    sourceSet.add(m.source);
    if (m.type === 'peer') nPeer += 1;
    else if (m.type === 'hot') nHot += 1;
    else if (m.type === 'knowledge') nKnowledge += 1;
  }

  const weighted = nPeer * t.weight.peer + nHot * t.weight.hot + nKnowledge * t.weight.knowledge;
  // halfSaturation>0 保证 weighted=0 时 score=0 且无除零。
  const score = Math.round((100 * weighted) / (weighted + t.halfSaturation));

  const coveredPlatforms = coveredPlatformsOf(materials);
  const sampleFactor = clamp(sampleSize / t.confidentSampleSize, 0, 1);
  const coverageFactor = clamp(coveredPlatforms.length / t.confidentPlatformCount, 0, 1);
  const confidence = round2(sampleFactor * coverageFactor);
  const sufficient = sampleSize >= t.minSampleSize && confidence >= t.sufficientConfidence;

  return {
    score,
    level: saturationLevel(score),
    confidence,
    sampleSize,
    coveredPlatforms,
    sources: [...sourceSet].sort(),
    sufficient,
  };
}