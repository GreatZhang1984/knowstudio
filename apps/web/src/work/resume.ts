import { resumePath } from '@knowstudio/domain';
import type { WorkStep } from '@knowstudio/contracts';

/** 没有可续作的 Work 时回作品列表（SPEC §2.5 域入口脚注）。 */
export const NO_WORK_FALLBACK = '/works';

export interface ResumeTarget {
  id: string;
  step: WorkStep;
}

/**
 * 域入口 /studio 与 /publish 的落点。续作路径一律由 domain.resumePath 给出，
 * 不在前端另抄一份 STEP_META（D-02 的根因就是两处各写一份）。
 */
export function domainEntryTarget(work: ResumeTarget | null | undefined): string {
  return work == null ? NO_WORK_FALLBACK : resumePath(work.step, work.id);
}

/** 步进器点击某一段时的落点：取该段的入口 step，仍由 resumePath 拼。 */
const STAGE_ENTRY_STEP = {
  0: 'search',
  1: 'topics',
  2: 'video.draft',
  3: 'derive',
} as const satisfies Record<0 | 1 | 2 | 3, WorkStep>;

export function stagePath(phase: 0 | 1 | 2 | 3, workId: string): string {
  return resumePath(STAGE_ENTRY_STEP[phase], workId);
}