import { describe, expect, it } from 'vitest';
import { PHASES, WorkStep, type Phase } from '@knowstudio/contracts';
import { STEP_META, STEP_ORDER, phaseOf, progressOf, resumePath, stepRank } from '../../src/index.js';
import { OTHER_WORK_ID, WORK_ID, deepFreeze } from '../fixtures.js';

/**
 * 期望值逐行抄自 SPEC §2.2「Work 状态机」权重表
 * （spark-output/spec/knowledge-video-tool.md:117-127），
 * 与架构 §5.1 的 STEP_META 契约示意（architecture/knowledge-video-tool.md:1101-1111）一致。
 * 文档用 `[id]` 表示路由占位，架构 §5.1 代码示意写作 `:id`，此处按后者。
 * `resumeW1` 列是把 w1 代入 SPEC §2.5 路由表后的字面路径，
 * 其中 /studio/w1/script、/studio/w1/render、/publish/w1 三处直接见于架构 §5.6 信封示例。
 * 不从被测源码反推任何期望值。
 */
type Row = { step: WorkStep; phase: Phase; progress: number; resume: string; resumeW1: string };

const SPEC_TABLE: readonly Row[] = [
  { step: 'search', phase: 0, progress: 15, resume: '/discover', resumeW1: '/discover' },
  { step: 'topics', phase: 1, progress: 30, resume: '/discover/topics', resumeW1: '/discover/topics' },
  { step: 'script', phase: 1, progress: 50, resume: '/studio/:id/script', resumeW1: '/studio/w1/script' },
  { step: 'video.draft', phase: 2, progress: 60, resume: '/studio/:id/video', resumeW1: '/studio/w1/video' },
  { step: 'video.rendering', phase: 2, progress: 70, resume: '/studio/:id/render', resumeW1: '/studio/w1/render' },
  { step: 'video.rendered', phase: 2, progress: 75, resume: '/studio/:id/video', resumeW1: '/studio/w1/video' },
  { step: 'derive', phase: 3, progress: 90, resume: '/publish/:id', resumeW1: '/publish/w1' },
  { step: 'export', phase: 3, progress: 95, resume: '/publish/:id/export', resumeW1: '/publish/w1/export' },
  { step: 'done', phase: 4, progress: 100, resume: '/works/:id', resumeW1: '/works/w1' },
];

describe('SPEC §2.2 权重表逐行一致（T-11 验收：9 个 step 权重与 SPEC 表逐行一致）', () => {
  it('恰好 9 个 step，无遗漏无多余', () => {
    expect(Object.keys(STEP_META)).toHaveLength(9);
    expect(Object.keys(STEP_META).sort()).toEqual(SPEC_TABLE.map((r) => r.step).sort());
  });

  it('声明顺序即 SPEC §2.2 表顺序（也是「只进不退」的比较依据）', () => {
    expect([...STEP_ORDER]).toEqual(SPEC_TABLE.map((r) => r.step));
    expect(Object.keys(STEP_META)).toEqual(SPEC_TABLE.map((r) => r.step));
  });

  it('与契约 WorkStep 枚举同值同序（SPEC §4.2 / 架构 §4.2）', () => {
    expect([...STEP_ORDER]).toEqual([...WorkStep.values]);
  });

  for (const row of SPEC_TABLE) {
    it(`${row.step} → phase=${row.phase} progress=${row.progress} resume=${row.resume}`, () => {
      expect(STEP_META[row.step]).toEqual({
        phase: row.phase,
        progress: row.progress,
        resume: row.resume,
      });
    });

    it(`${row.step}：phaseOf / progressOf 与表一致`, () => {
      expect(phaseOf(row.step)).toBe(row.phase);
      expect(progressOf(row.step)).toBe(row.progress);
    });

    it(`${row.step}：resumePath(w1) = ${row.resumeW1}`, () => {
      expect(resumePath(row.step, WORK_ID)).toBe(row.resumeW1);
    });

    it(`${row.step}：stepRank = ${SPEC_TABLE.indexOf(row)}`, () => {
      expect(stepRank(row.step)).toBe(SPEC_TABLE.indexOf(row));
    });
  }
});

describe('确定性进度的不变量（SPEC §2.2 / 架构 §5.1：progress 不入库，前后端共用一份表）', () => {
  it('progress 沿 step 顺序严格递增，杜绝原型硬编码 42/68/100（D-02）', () => {
    const progresses = SPEC_TABLE.map((r) => progressOf(r.step));
    expect(progresses).toEqual([15, 30, 50, 60, 70, 75, 90, 95, 100]);
    for (let i = 1; i < progresses.length; i += 1) {
      expect(progresses[i]!).toBeGreaterThan(progresses[i - 1]!);
    }
  });

  it('progress 是 0–100 的整数（契约 WorkEnvelopeSchema.progress）', () => {
    for (const row of SPEC_TABLE) {
      expect(Number.isInteger(progressOf(row.step))).toBe(true);
      expect(progressOf(row.step)).toBeGreaterThanOrEqual(0);
      expect(progressOf(row.step)).toBeLessThanOrEqual(100);
    }
  });

  it('phase 沿 step 顺序单调不减，值域为 SPEC §2.2 的 0–4', () => {
    const phases = SPEC_TABLE.map((r) => phaseOf(r.step));
    expect(phases).toEqual([0, 1, 1, 2, 2, 2, 3, 3, 4]);
    for (let i = 1; i < phases.length; i += 1) {
      expect(phases[i]!).toBeGreaterThanOrEqual(phases[i - 1]!);
    }
    for (const p of phases) expect(PHASES).toContain(p);
  });

  it('四段流水线语义：0 搜 / 1 想 / 2 做 / 3 发 / 4 已导出', () => {
    expect(SPEC_TABLE.filter((r) => phaseOf(r.step) === 0).map((r) => r.step)).toEqual(['search']);
    expect(SPEC_TABLE.filter((r) => phaseOf(r.step) === 1).map((r) => r.step)).toEqual([
      'topics',
      'script',
    ]);
    expect(SPEC_TABLE.filter((r) => phaseOf(r.step) === 2).map((r) => r.step)).toEqual([
      'video.draft',
      'video.rendering',
      'video.rendered',
    ]);
    expect(SPEC_TABLE.filter((r) => phaseOf(r.step) === 3).map((r) => r.step)).toEqual([
      'derive',
      'export',
    ]);
    expect(SPEC_TABLE.filter((r) => phaseOf(r.step) === 4).map((r) => r.step)).toEqual(['done']);
  });

  it('stepRank 与 STEP_ORDER 下标一致，且互不相同', () => {
    const ranks = SPEC_TABLE.map((r) => stepRank(r.step));
    expect(ranks).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(new Set(ranks).size).toBe(9);
    for (const row of SPEC_TABLE) expect(STEP_ORDER[stepRank(row.step)]).toBe(row.step);
  });
});

describe('resumePath 的 workId 隔离（D-01 / D-05：按 workId 隔离，不得硬编码单 Work）', () => {
  it('另一个 Work 得到自己的路径，不串上下文', () => {
    expect(resumePath('script', OTHER_WORK_ID)).toBe('/studio/w2/script');
    expect(resumePath('video.rendering', OTHER_WORK_ID)).toBe('/studio/w2/render');
    expect(resumePath('derive', OTHER_WORK_ID)).toBe('/publish/w2');
    expect(resumePath('export', OTHER_WORK_ID)).toBe('/publish/w2/export');
    expect(resumePath('done', OTHER_WORK_ID)).toBe('/works/w2');
  });

  it('任何 step 的续作路径都不残留 :id 占位', () => {
    for (const row of SPEC_TABLE) {
      expect(resumePath(row.step, WORK_ID)).not.toContain(':id');
      expect(resumePath(row.step, OTHER_WORK_ID)).not.toContain(':id');
    }
  });

  it('无占位的两步（search / topics）与 workId 无关（SPEC §2.5：这两页不带 [id]）', () => {
    expect(resumePath('search', OTHER_WORK_ID)).toBe('/discover');
    expect(resumePath('topics', OTHER_WORK_ID)).toBe('/discover/topics');
    expect(resumePath('search', WORK_ID)).toBe(resumePath('search', OTHER_WORK_ID));
    expect(resumePath('topics', WORK_ID)).toBe(resumePath('topics', OTHER_WORK_ID));
  });

  it('video.draft 与 video.rendered 都回视频页，video.rendering 回渲染中心（SPEC §2.2）', () => {
    expect(resumePath('video.draft', WORK_ID)).toBe(resumePath('video.rendered', WORK_ID));
    expect(resumePath('video.rendering', WORK_ID)).toBe('/studio/w1/render');
  });
});

describe('纯函数性（架构 §3.2：domain 零 IO，可在前端复用）', () => {
  it('重复调用结果恒定', () => {
    for (const row of SPEC_TABLE) {
      expect(phaseOf(row.step)).toBe(phaseOf(row.step));
      expect(progressOf(row.step)).toBe(progressOf(row.step));
      expect(resumePath(row.step, WORK_ID)).toBe(resumePath(row.step, WORK_ID));
      expect(stepRank(row.step)).toBe(stepRank(row.step));
    }
  });

  it('不修改权重表本身（表被冻结后仍可正常求值）', () => {
    const before = JSON.stringify(STEP_META);
    deepFreeze(STEP_META);
    deepFreeze(STEP_ORDER);
    for (const row of SPEC_TABLE) {
      expect(phaseOf(row.step)).toBe(row.phase);
      expect(progressOf(row.step)).toBe(row.progress);
      expect(resumePath(row.step, WORK_ID)).toBe(row.resumeW1);
      expect(stepRank(row.step)).toBe(SPEC_TABLE.indexOf(row));
    }
    expect(JSON.stringify(STEP_META)).toBe(before);
  });
});