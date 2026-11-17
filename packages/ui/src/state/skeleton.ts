/** 骨架屏的形状与数量：纯函数，便于单测（SPEC §9 各屏的加载列形状不同）。 */

export type SkeletonVariant = 'cards' | 'grid' | 'list' | 'text' | 'inline';

/** 默认数量取自 SPEC §9：素材搜索 3×3 骨架、文案编辑三段骨架。 */
const DEFAULT_COUNT: Record<SkeletonVariant, number> = {
  cards: 3,
  grid: 9,
  list: 5,
  text: 3,
  inline: 1,
};

const MAX_COUNT = 24;

export function skeletonCount(variant: SkeletonVariant, count?: number): number {
  const raw = count ?? DEFAULT_COUNT[variant];
  if (!Number.isFinite(raw)) return DEFAULT_COUNT[variant];
  return Math.min(MAX_COUNT, Math.max(1, Math.floor(raw)));
}

export const SKELETON_VARIANTS = Object.keys(DEFAULT_COUNT) as SkeletonVariant[];