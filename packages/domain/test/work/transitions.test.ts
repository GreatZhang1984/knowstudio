import { describe, expect, it } from 'vitest';
import { WorkStep } from '@knowstudio/contracts';
import {
  REGRESSIVE_EVENTS,
  STEP_TRANSITIONS,
  UNLOCK_INVALIDATES_GATES,
  isStep,
  nextStep,
  type WorkEvent,
} from '../../src/index.js';
import { deepFreeze } from '../fixtures.js';

/**
 * 期望值抄自架构 §5.1「step 迁移规则（只进不退，除显式解锁）」表
 * （spark-output/architecture/knowledge-video-tool.md:1116-1127），
 * 回退语义另见 SPEC §3.4「解锁并重新确认」（spec:326）与架构 §5.1 表下注（arch:1129）。
 * 表中「触发」列有一半是中文描述（创建 Work / 首次收藏素材 / draft job succeeded …），
 * 事件标识符是 domain 对该列的命名；本测试只对「目标 step」与「只进不退/显式回退」规则做断言，
 * 这两项完全由文档决定，不从被测源码反推。
 */
const DOC_ROWS = [
  ['work:create', 'search', '创建 Work'],
  ['material:firstCollect', 'topics', '首次收藏素材'],
  ['topic:select', 'script', 'topic:select（置 G1）'],
  ['script:confirm', 'video.draft', 'script:confirm（置 G2，Script.status=confirmed）'],
  ['draft:succeeded', 'video.draft', 'draft job succeeded'],
  ['hd:enqueued', 'video.rendering', 'hd job 入队（写 active_render_job_id）'],
  ['hd:succeeded', 'video.rendered', 'hd job succeeded（置 G3）'],
  ['derive:metadataReady', 'derive', 'metadata 派生完成（允许在 rendering 期间发生，D-07）'],
  ['export:enqueued', 'export', 'export job 入队（G4 已满足）'],
  ['export:succeeded', 'done', 'export succeeded（写 exported_at）'],
  ['script:unlock', 'script', 'script:unlock（G2/G3/G4 全部失效）'],
] as const satisfies readonly (readonly [WorkEvent, WorkStep, string])[];

const DOC_TARGET = Object.fromEntries(DOC_ROWS.map(([e, t]) => [e, t])) as Record<
  WorkEvent,
  WorkStep
>;

/** SPEC §2.2 表顺序与权重（spec:117-127），本文件自带一份，避免用被测源码当期望。 */
const DOC_ORDER: readonly WorkStep[] = [
  'search',
  'topics',
  'script',
  'video.draft',
  'video.rendering',
  'video.rendered',
  'derive',
  'export',
  'done',
];
const DOC_PROGRESS: Record<WorkStep, number> = {
  'search': 15,
  'topics': 30,
  'script': 50,
  'video.draft': 60,
  'video.rendering': 70,
  'video.rendered': 75,
  'derive': 90,
  'export': 95,
  'done': 100,
};

const docRank = (s: WorkStep): number => DOC_ORDER.indexOf(s);

/** 架构 §5.1 的两条规则：只进不退；script:unlock 是唯一显式回退。 */
function expectedNext(current: WorkStep, event: WorkEvent): WorkStep {
  const target = DOC_TARGET[event];
  if (event === 'script:unlock') return target;
  return docRank(target) > docRank(current) ? target : current;
}

const ALL_EVENTS = DOC_ROWS.map(([e]) => e);

describe('架构 §5.1 迁移表逐行一致（T-11 验收：单测覆盖全部迁移）', () => {
  it('恰好 11 个触发事件，无遗漏无多余', () => {
    expect(Object.keys(STEP_TRANSITIONS).sort()).toEqual([...ALL_EVENTS].sort());
    expect(Object.keys(STEP_TRANSITIONS)).toHaveLength(11);
  });

  for (const [event, target, label] of DOC_ROWS) {
    it(`${event}（${label}）→ ${target}`, () => {
      expect(STEP_TRANSITIONS[event]).toBe(target);
    });
  }

  it('REGRESSIVE_EVENTS 只有 script:unlock（架构 §5.1「除显式解锁」）', () => {
    expect([...REGRESSIVE_EVENTS]).toEqual(['script:unlock']);
  });

  it('UNLOCK_INVALIDATES_GATES = G2/G3/G4（架构 §5.1 副作用列 / SPEC §3.4）', () => {
    expect([...UNLOCK_INVALIDATES_GATES]).toEqual(['G2', 'G3', 'G4']);
  });

  it('解锁不失效 G1：选题是独立的人工判断（SPEC §2.3 G1 解锁条件只含 selectedTopicId）', () => {
    expect(UNLOCK_INVALIDATES_GATES).not.toContain('G1');
  });
});

/**
 * 这条不变量**不抄迁移表**，只抄 SPEC §2.2 的 step 清单（spec:117-127）。
 * 存在的理由：迁移表与它的逐行测试同源，表里漏一行，测试会跟着漏，两边一起绿。
 * 实际发生过——`export`(95%) 在 progress.ts 有定义、details.ts 会把它当 redirectTo 下发、
 * web fixtures 也在用，但迁移表没有任何事件指向它，于是生产里永远到不了这个 step，
 * SPEC §2.2「任意时刻可离开，回来按 step 续作」对导出中断线。
 * 用「每个 step 都必须可达」独立兜住这一类缺口。
 */
describe('SPEC §2.2 可达性：每个 step 都必须有事件能到达', () => {
  it('除初始 step search 外，DOC_ORDER 里每个 step 都是某个事件的目标', () => {
    const targets = new Set<string>(Object.values(STEP_TRANSITIONS));
    const unreachable = DOC_ORDER.filter((s) => s !== 'search' && !targets.has(s));
    expect(unreachable).toEqual([]);
  });

  it('迁移表的目标 step 都在 SPEC §2.2 清单内（不得造出文档没有的 step）', () => {
    const unknown = Object.values(STEP_TRANSITIONS).filter((s) => !DOC_ORDER.includes(s));
    expect(unknown).toEqual([]);
  });

  it('导出中断可续作：derive 上入队导出 → export，落地页是导出页', () => {
    const step = nextStep('derive', 'export:enqueued');
    expect(step).toBe('export');
    expect(DOC_PROGRESS[step]).toBe(95);
  });
});

describe('nextStep 全矩阵：11 事件 × 9 当前 step = 99 格', () => {
  for (const event of ALL_EVENTS) {
    for (const current of DOC_ORDER) {
      const expected = expectedNext(current, event);
      it(`${event} @ ${current} → ${expected}`, () => {
        expect(nextStep(current, event)).toBe(expected);
      });
    }
  }
});

describe('只进不退（架构 §5.1）', () => {
  it('任何非回退事件都不会让进度回落', () => {
    for (const event of ALL_EVENTS) {
      if (event === 'script:unlock') continue;
      for (const current of DOC_ORDER) {
        const next = nextStep(current, event);
        expect(DOC_PROGRESS[next]).toBeGreaterThanOrEqual(DOC_PROGRESS[current]);
        expect(docRank(next)).toBeGreaterThanOrEqual(docRank(current));
      }
    }
  });

  it('目标 step 不晚于当前 step 时保持原状（事件乱序到达不降级）', () => {
    expect(nextStep('done', 'work:create')).toBe('done');
    expect(nextStep('done', 'topic:select')).toBe('done');
    expect(nextStep('derive', 'hd:enqueued')).toBe('derive');
    expect(nextStep('video.rendered', 'script:confirm')).toBe('video.rendered');
    expect(nextStep('export', 'hd:succeeded')).toBe('export');
  });

  it('done 对所有非回退事件都是终态', () => {
    for (const event of ALL_EVENTS) {
      if (event === 'script:unlock') continue;
      expect(nextStep('done', event)).toBe('done');
    }
  });

  it('同一事件重复投递幂等（幂等写 / SSE 重放前提，架构 §10.3）', () => {
    for (const event of ALL_EVENTS) {
      for (const current of DOC_ORDER) {
        const once = nextStep(current, event);
        expect(nextStep(once, event)).toBe(once);
      }
    }
  });
});

describe('D-07：metadata 派生可在渲染期完成，step 不得因此回落（架构 §5.1 注 / §5.4）', () => {
  it('rendering 期间 metadata 就绪 → derive(90)', () => {
    expect(nextStep('video.rendering', 'derive:metadataReady')).toBe('derive');
    expect(DOC_PROGRESS[nextStep('video.rendering', 'derive:metadataReady')]).toBe(90);
  });

  it('随后 hd:succeeded 的目标 video.rendered(75) 不得把 derive(90) 拉回去', () => {
    const afterMetadata = nextStep('video.rendering', 'derive:metadataReady');
    const afterHd = nextStep(afterMetadata, 'hd:succeeded');
    expect(afterHd).toBe('derive');
    expect(DOC_PROGRESS[afterHd]).toBe(90);
  });

  it('渲染在途不由 step 回退表达：hd:enqueued 之后仍可到 derive', () => {
    const rendering = nextStep('video.draft', 'hd:enqueued');
    expect(rendering).toBe('video.rendering');
    expect(nextStep(rendering, 'derive:metadataReady')).toBe('derive');
  });
});

describe('script:unlock 是唯一回退（SPEC §3.4 / 架构 §5.1 注：进度回落是正确行为）', () => {
  it('从任何已确认文案之后的 step 都拉回 script', () => {
    for (const current of DOC_ORDER.slice(docRank('script'))) {
      expect(nextStep(current, 'script:unlock')).toBe('script');
    }
  });

  it('进度随之回落到 50%', () => {
    for (const current of DOC_ORDER.slice(docRank('video.draft'))) {
      expect(DOC_PROGRESS[nextStep(current, 'script:unlock')]).toBe(50);
      expect(DOC_PROGRESS[nextStep(current, 'script:unlock')]).toBeLessThan(
        DOC_PROGRESS[current],
      );
    }
  });

  it('解锁后再确认可以重新前进（解锁并重新确认闭环）', () => {
    const unlocked = nextStep('video.rendered', 'script:unlock');
    expect(unlocked).toBe('script');
    expect(nextStep(unlocked, 'script:confirm')).toBe('video.draft');
    expect(nextStep(nextStep(unlocked, 'script:confirm'), 'hd:enqueued')).toBe('video.rendering');
  });
});

describe('核心闭环 happy path（SPEC §2.2 状态机图 / §12.2 QA 主用例）', () => {
  it('创建 → 收藏 → 选题 → 确认 → 草稿 → 入队 → 成片 → 派生 → 导出', () => {
    const chain: readonly [WorkEvent, WorkStep, number][] = [
      ['work:create', 'search', 15],
      ['material:firstCollect', 'topics', 30],
      ['topic:select', 'script', 50],
      ['script:confirm', 'video.draft', 60],
      ['draft:succeeded', 'video.draft', 60],
      ['hd:enqueued', 'video.rendering', 70],
      ['hd:succeeded', 'video.rendered', 75],
      ['derive:metadataReady', 'derive', 90],
      ['export:succeeded', 'done', 100],
    ];
    let step: WorkStep = 'search';
    for (const [event, expected, progress] of chain) {
      step = nextStep(step, event);
      expect(step).toBe(expected);
      expect(DOC_PROGRESS[step]).toBe(progress);
    }
  });

  it('draft 成功不推进 step（草稿与高清共享音轨，架构 §5.1 / ADR-03）', () => {
    expect(nextStep('video.draft', 'draft:succeeded')).toBe('video.draft');
    expect(DOC_PROGRESS[nextStep('video.draft', 'draft:succeeded')]).toBe(60);
  });
});

describe('isStep 值域（SPEC §4.2 Work.step 枚举）', () => {
  it('9 个合法 step 全部为 true', () => {
    for (const step of DOC_ORDER) expect(isStep(step)).toBe(true);
  });

  it('与契约 WorkStep 枚举判定一致', () => {
    const probes = [...DOC_ORDER, 'video', 'Video', 'SEARCH', 'done ', '', 'G1', 'export:done'];
    for (const p of probes) expect(isStep(p)).toBe(WorkStep.safeParse(p).success);
  });

  it('大小写、近义串、空串、前后空白一律 false', () => {
    const invalid = [
      '',
      ' ',
      'Search',
      'SEARCH',
      'Topics',
      'SCRIPT',
      'video',
      'video.',
      'video.render',
      'video.Draft',
      'video.rendering ',
      ' video.draft',
      'done!',
      'derives',
      'exports',
      'G1',
      'phase2',
      '42',
      'null',
      'undefined',
    ];
    for (const v of invalid) expect(isStep(v)).toBe(false);
  });

  it('原型链上的键不是 step（防注入）', () => {
    for (const v of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(isStep(v)).toBe(false);
    }
  });
});

describe('纯函数性（架构 §3.2）', () => {
  it('迁移表与常量被冻结后仍可正常求值，且不被修改', () => {
    const before = JSON.stringify(STEP_TRANSITIONS);
    deepFreeze(STEP_TRANSITIONS);
    deepFreeze(REGRESSIVE_EVENTS);
    deepFreeze(UNLOCK_INVALIDATES_GATES);
    for (const event of ALL_EVENTS) {
      for (const current of DOC_ORDER) {
        expect(nextStep(current, event)).toBe(expectedNext(current, event));
      }
    }
    expect(JSON.stringify(STEP_TRANSITIONS)).toBe(before);
  });

  it('同一输入重复调用结果恒定', () => {
    for (const event of ALL_EVENTS) {
      for (const current of DOC_ORDER) {
        expect(nextStep(current, event)).toBe(nextStep(current, event));
      }
    }
  });
});