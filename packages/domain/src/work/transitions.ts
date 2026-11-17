import type { WorkStep } from '@knowstudio/contracts';
import { STEP_ORDER, stepRank } from './progress.js';

/** 架构 §5.1 step 迁移表的触发事件。 */
export type WorkEvent =
  | 'work:create'
  | 'material:firstCollect'
  | 'topic:select'
  | 'script:confirm'
  | 'draft:succeeded'
  | 'hd:enqueued'
  | 'hd:succeeded'
  | 'derive:metadataReady'
  | 'export:enqueued'
  | 'export:succeeded'
  | 'script:unlock';

export const STEP_TRANSITIONS = {
  'work:create': 'search',
  'material:firstCollect': 'topics',
  'topic:select': 'script',
  'script:confirm': 'video.draft',
  'draft:succeeded': 'video.draft',
  'hd:enqueued': 'video.rendering',
  'hd:succeeded': 'video.rendered',
  'derive:metadataReady': 'derive',
  'export:enqueued': 'export',
  'export:succeeded': 'done',
  'script:unlock': 'script',
} as const satisfies Record<WorkEvent, WorkStep>;

/** 解锁文案是 SPEC §3.4 明写的回退，G2/G3/G4 随之全部失效。 */
export const REGRESSIVE_EVENTS: readonly WorkEvent[] = ['script:unlock'];

/**
 * 只进不退，除显式解锁（架构 §5.1）。
 *
 * 取 max 而非直接赋值，是因为 D-07 允许 metadata 派生在渲染期完成：
 * 此时 step 已到 derive(90)，随后 hd:succeeded 的目标 video.rendered(75)
 * 若直接赋值会造成非预期的进度回落。渲染在途由信封的 activeRenderJobId
 * 与 parallelHint 表达，不靠 step 回退表达。
 */
export function nextStep(current: WorkStep, event: WorkEvent): WorkStep {
  const target = STEP_TRANSITIONS[event];
  if (REGRESSIVE_EVENTS.includes(event)) return target;
  return stepRank(target) > stepRank(current) ? target : current;
}

/** 解锁后必须把所有成片标记为陈旧，否则 G3 会拿旧母版放行。 */
export const UNLOCK_INVALIDATES_GATES = ['G2', 'G3', 'G4'] as const;

export function isStep(value: string): value is WorkStep {
  return (STEP_ORDER as readonly string[]).includes(value);
}