import type { Phase, WorkStep } from '@knowstudio/contracts';

/**
 * 架构 §5.1 / SPEC §2.2 的确定性进度表。progress 不入库，前后端共用这一份。
 * 顺序即 WorkStep 枚举声明顺序，也是「只进不退」的比较依据。
 */
export const STEP_META = {
  'search': { phase: 0, progress: 15, resume: '/discover' },
  'topics': { phase: 1, progress: 30, resume: '/discover/topics' },
  'script': { phase: 1, progress: 50, resume: '/studio/:id/script' },
  'video.draft': { phase: 2, progress: 60, resume: '/studio/:id/video' },
  'video.rendering': { phase: 2, progress: 70, resume: '/studio/:id/render' },
  'video.rendered': { phase: 2, progress: 75, resume: '/studio/:id/video' },
  'derive': { phase: 3, progress: 90, resume: '/publish/:id' },
  'export': { phase: 3, progress: 95, resume: '/publish/:id/export' },
  'done': { phase: 4, progress: 100, resume: '/works/:id' },
} as const satisfies Record<WorkStep, { phase: Phase; progress: number; resume: string }>;

export const STEP_ORDER = Object.keys(STEP_META) as WorkStep[];

export const phaseOf = (step: WorkStep): Phase => STEP_META[step].phase;

export const progressOf = (step: WorkStep): number => STEP_META[step].progress;

export const resumePath = (step: WorkStep, workId: string): string =>
  STEP_META[step].resume.replace(':id', workId);

export const stepRank = (step: WorkStep): number => STEP_ORDER.indexOf(step);