import { describe, expect, it } from 'vitest';
import {
  GateDetailsSchema,
  GateReason,
  ParallelHintSchema,
  type Gates,
  type WorkTruthSnapshot,
} from '@knowstudio/contracts';
import { deriveGateDetails, deriveGates, deriveParallelHint } from '../../src/index.js';
import {
  CONFIRMED_AT,
  OTHER_WORK_ID,
  RENDER_JOB_ID,
  SCRIPT_VERSION,
  WORK_ID,
  allSatisfied,
  deepFreeze,
  emptyWork,
  truth,
  withReport,
} from '../fixtures.js';

/**
 * 期望值抄自架构 §5.6「闸门状态响应契约」的信封示例
 * （spark-output/architecture/knowledge-video-tool.md:1226-1241）：
 *   gateDetails 只出现未满足的 G3，reason=HD_RENDER_NOT_SUCCEEDED，
 *   redirectTo=/studio/w1/render，activeJobId=job_88；
 *   parallelHint={enabled:true, cta:'渲染时你可以先去写平台标题', redirectTo:'/publish/w1'}。
 * G2 的 redirectTo=/studio/w1/script 另见架构 §5.3 时序图（arch:1178）。
 * 其余门的修复入口按 SPEC §2.5 路由表（spec:174-193）代入 w1。
 * reason 取值域见契约 GateReason（packages/contracts/src/dto.ts:61-70，
 * 注释明写「逐条对应架构 §5.2 deriveGates 的判定分支」），分支顺序按架构 §5.2 的合取顺序。
 * 「只下发未满足的门、前端不做本地布尔判断」见架构 §5.5（arch:1218）。
 * 注意：§5.6 示例自身不自洽——gates 里 G4=false，gateDetails 却只画了 G3。
 * 本测试以 §5.5 的规则为准（未满足的门一律下发），只逐字断言示例给出的 G3 那一条。
 */
const detailsOf = (s: WorkTruthSnapshot, job: string | null = null) =>
  deriveGateDetails(s, deriveGates(s), job);

const STALE_FINGERPRINT = '0'.repeat(64);
const NO_HINT = { enabled: false, cta: '', redirectTo: '' };
const HINT_CTA = '渲染时你可以先去写平台标题';

describe('只下发未满足的门（架构 §5.5 / §5.6）', () => {
  it('四门全满足 → 空对象', () => {
    expect(detailsOf(allSatisfied())).toEqual({});
  });

  it('全新 Work → 四门各一条详情', () => {
    expect(Object.keys(detailsOf(emptyWork()))).toEqual(['G1', 'G2', 'G3', 'G4']);
  });

  it('已满足的门不下发详情，即使渲染在途', () => {
    expect(detailsOf(allSatisfied(), RENDER_JOB_ID)).toEqual({});
  });

  const onlyOne: readonly { gate: keyof Gates; over: Partial<WorkTruthSnapshot> }[] = [
    { gate: 'G1', over: { selectedTopicId: null } },
    { gate: 'G2', over: { script: { ...truth().script!, status: 'draft', confirmedAt: null } } },
    { gate: 'G3', over: { latestHdAsset: null } },
    { gate: 'G4', over: { latestCompliance: null } },
  ];

  for (const { gate, over } of onlyOne) {
    it(`只有 ${gate} 未满足 → 详情里只有 ${gate}`, () => {
      const details = detailsOf({ ...allSatisfied(), ...over });
      expect(Object.keys(details)).toEqual([gate]);
      expect(details[gate]?.satisfied).toBe(false);
    });
  }

  it('所有详情 satisfied 恒为 false（满足的门根本不出现在详情里）', () => {
    for (const s of [emptyWork(), truth(), withReport(truth(), 2), allSatisfied()]) {
      for (const d of Object.values(detailsOf(s, RENDER_JOB_ID))) {
        expect(d?.satisfied).toBe(false);
      }
    }
  });

  it('未满足的门必有 reason，且落在契约 GateReason 值域内', () => {
    for (const s of [emptyWork(), truth(), withReport(truth(), 1)]) {
      for (const d of Object.values(detailsOf(s))) {
        expect(d?.reason).toBeDefined();
        expect(GateReason.safeParse(d?.reason).success).toBe(true);
      }
    }
  });

  it('详情满足契约 GateDetailsSchema（架构 §5.6 信封）', () => {
    for (const s of [emptyWork(), truth(), allSatisfied(), withReport(truth(), 3)]) {
      for (const job of [null, RENDER_JOB_ID]) {
        const details = detailsOf(s, job);
        expect(GateDetailsSchema.parse(details)).toEqual(details);
      }
    }
  });
});

describe('G1 reason 与修复入口（SPEC §2.3 / §2.5 page-topics）', () => {
  it('未选题 → TOPIC_NOT_SELECTED + /discover/topics', () => {
    expect(detailsOf({ ...allSatisfied(), selectedTopicId: null }).G1).toEqual({
      satisfied: false,
      reason: 'TOPIC_NOT_SELECTED',
      redirectTo: '/discover/topics',
    });
  });
});

describe('G2 reason 与修复入口（架构 §5.3 时序图：redirectTo=/studio/w1/script）', () => {
  const cases: readonly { name: string; script: WorkTruthSnapshot['script'] }[] = [
    { name: '无文案', script: null },
    { name: 'draft 未确认', script: { ...truth().script!, status: 'draft', confirmedAt: null } },
    {
      name: 'confirmed 但 confirmedAt 为空',
      script: { ...truth().script!, status: 'confirmed', confirmedAt: null },
    },
    { name: 'stale 已解锁', script: { ...truth().script!, status: 'stale', confirmedAt: CONFIRMED_AT } },
  ];

  for (const c of cases) {
    it(`${c.name} → SCRIPT_NOT_CONFIRMED + /studio/w1/script`, () => {
      expect(detailsOf(truth({ script: c.script })).G2).toEqual({
        satisfied: false,
        reason: 'SCRIPT_NOT_CONFIRMED',
        redirectTo: '/studio/w1/script',
      });
    });
  }
});

describe('G3 reason 三分支与修复入口（架构 §5.2 合取顺序 / §5.6 示例）', () => {
  it('无成片 → HD_RENDER_NOT_SUCCEEDED', () => {
    expect(detailsOf(truth({ latestHdAsset: null })).G3?.reason).toBe('HD_RENDER_NOT_SUCCEEDED');
  });

  for (const status of ['queued', 'running', 'failed', 'canceled'] as const) {
    it(`成片 status=${status} → HD_RENDER_NOT_SUCCEEDED`, () => {
      const s = truth({
        latestHdAsset: { id: 'va1', status, stale: false, scriptVersion: SCRIPT_VERSION },
      });
      expect(detailsOf(s).G3?.reason).toBe('HD_RENDER_NOT_SUCCEEDED');
    });
  }

  it('成片 stale → HD_ASSET_STALE（SPEC §3.4 解锁后标记陈旧）', () => {
    const s = truth({
      latestHdAsset: { id: 'va1', status: 'succeeded', stale: true, scriptVersion: SCRIPT_VERSION },
    });
    expect(detailsOf(s).G3?.reason).toBe('HD_ASSET_STALE');
  });

  it('成片版本与母版不一致 → HD_ASSET_SCRIPT_VERSION_MISMATCH', () => {
    const s = truth({
      latestHdAsset: { id: 'va1', status: 'succeeded', stale: false, scriptVersion: SCRIPT_VERSION - 1 },
    });
    expect(detailsOf(s).G3?.reason).toBe('HD_ASSET_SCRIPT_VERSION_MISMATCH');
  });

  it('同时 stale 且版本不一致时先报 stale（架构 §5.2 合取顺序：status → stale → version）', () => {
    const s = truth({
      latestHdAsset: { id: 'va1', status: 'succeeded', stale: true, scriptVersion: SCRIPT_VERSION - 1 },
    });
    expect(detailsOf(s).G3?.reason).toBe('HD_ASSET_STALE');
  });

  it('未 succeeded 且 stale 时先报未 succeeded', () => {
    const s = truth({
      latestHdAsset: { id: 'va1', status: 'failed', stale: true, scriptVersion: SCRIPT_VERSION },
    });
    expect(detailsOf(s).G3?.reason).toBe('HD_RENDER_NOT_SUCCEEDED');
  });

  it('无在途渲染任务 → 回视频页 /studio/w1/video', () => {
    expect(detailsOf(truth({ latestHdAsset: null })).G3?.redirectTo).toBe('/studio/w1/video');
  });

  it('渲染在途 → 回渲染中心 /studio/w1/render（架构 §5.6 示例）', () => {
    expect(detailsOf(truth({ latestHdAsset: null }), RENDER_JOB_ID).G3?.redirectTo).toBe(
      '/studio/w1/render',
    );
  });

  it('渲染在途时带 activeJobId，值即传入的 job_88', () => {
    const d = detailsOf(truth({ latestHdAsset: null }), RENDER_JOB_ID).G3;
    expect(d?.activeJobId).toBe(RENDER_JOB_ID);
  });

  it('无在途任务时不出现 activeJobId 键', () => {
    const d = detailsOf(truth({ latestHdAsset: null })).G3;
    expect(d).not.toHaveProperty('activeJobId');
  });

  it('activeJobId 只属于 G3：G1/G2/G4 即使渲染在途也不带', () => {
    const details = detailsOf(emptyWork(), RENDER_JOB_ID);
    for (const gate of ['G1', 'G2', 'G4'] as const) {
      expect(details[gate]).not.toHaveProperty('activeJobId');
    }
    expect(details.G3?.activeJobId).toBe(RENDER_JOB_ID);
  });
});

describe('G4 reason 三分支与修复入口（架构 §8.4 / SPEC §2.5 page-export）', () => {
  it('无报告 → COMPLIANCE_REPORT_MISSING', () => {
    expect(detailsOf(truth({ latestCompliance: null })).G4).toEqual({
      satisfied: false,
      reason: 'COMPLIANCE_REPORT_MISSING',
      redirectTo: '/publish/w1',
    });
  });

  for (const blockingCount of [1, 2, 5]) {
    it(`blockingCount=${blockingCount} → COMPLIANCE_BLOCKING（SPEC §8.5 任一 block 禁止导出）`, () => {
      const d = detailsOf(withReport(truth(), blockingCount)).G4;
      expect(d?.reason).toBe('COMPLIANCE_BLOCKING');
      expect(d?.redirectTo).toBe('/publish/w1');
    });
  }

  it('blockingCount=0 但指纹陈旧 → COMPLIANCE_FINGERPRINT_STALE（D-04 根因）', () => {
    const s = truth({ latestCompliance: { blockingCount: 0, fingerprint: STALE_FINGERPRINT } });
    expect(detailsOf(s).G4?.reason).toBe('COMPLIANCE_FINGERPRINT_STALE');
  });

  it('同时有阻断项且指纹陈旧时先报阻断（架构 §5.2 合取顺序：blockingCount → fingerprint）', () => {
    const s = truth({ latestCompliance: { blockingCount: 2, fingerprint: STALE_FINGERPRINT } });
    expect(detailsOf(s).G4?.reason).toBe('COMPLIANCE_BLOCKING');
  });

  it('引入需授权素材 k3 后旧报告 → COMPLIANCE_FINGERPRINT_STALE（SPEC §12.2 QA 剧本）', () => {
    const reported = withReport(truth());
    const s: WorkTruthSnapshot = {
      ...reported,
      materials: [...reported.materials, { materialId: 'k3', license: 'restricted', licenseEvidenceVersion: 1 }],
    };
    expect(detailsOf(s).G4?.reason).toBe('COMPLIANCE_FINGERPRINT_STALE');
  });

  it('G4 三个 reason 的修复入口都不得指向 export 自身（选项 3 死循环回归护栏）', () => {
    const cases: WorkTruthSnapshot[] = [
      truth({ latestCompliance: null }),
      withReport(truth(), 2),
      truth({ latestCompliance: { blockingCount: 0, fingerprint: STALE_FINGERPRINT } }),
    ];
    for (const s of cases) {
      const d = detailsOf(s).G4;
      expect(d?.redirectTo).toBe('/publish/w1');
      expect(d?.redirectTo).not.toBe('/publish/w1/export');
    }
  });
});

describe('架构 §5.6 信封示例逐字复现', () => {
  const rendering: WorkTruthSnapshot = truth({
    latestHdAsset: { id: 'va1', status: 'running', stale: false, scriptVersion: SCRIPT_VERSION },
    latestCompliance: null,
  });

  it('gates = {G1:true,G2:true,G3:false,G4:false}', () => {
    expect(deriveGates(rendering)).toEqual({ G1: true, G2: true, G3: false, G4: false });
  });

  it('G3 详情的四个字段与示例逐字一致', () => {
    expect(detailsOf(rendering, RENDER_JOB_ID).G3).toEqual({
      satisfied: false,
      reason: 'HD_RENDER_NOT_SUCCEEDED',
      redirectTo: '/studio/w1/render',
      activeJobId: 'job_88',
    });
  });

  it('示例里 G4 也是 false，按 §5.5「只下发未满足的门」必须一并下发', () => {
    const details = detailsOf(rendering, RENDER_JOB_ID);
    expect(Object.keys(details)).toEqual(['G3', 'G4']);
    expect(details.G4).toEqual({
      satisfied: false,
      reason: 'COMPLIANCE_REPORT_MISSING',
      redirectTo: '/publish/w1',
    });
  });

  it('parallelHint 逐字一致', () => {
    expect(deriveParallelHint(rendering, deriveGates(rendering), RENDER_JOB_ID)).toEqual({
      enabled: true,
      cta: HINT_CTA,
      redirectTo: '/publish/w1',
    });
  });
});

describe('redirectTo 的 workId 隔离（D-01 / D-05）', () => {
  it('另一个 Work 的修复入口指向自己的路由', () => {
    const details = detailsOf(emptyWork(OTHER_WORK_ID), RENDER_JOB_ID);
    expect(details.G1?.redirectTo).toBe('/discover/topics');
    expect(details.G2?.redirectTo).toBe('/studio/w2/script');
    expect(details.G3?.redirectTo).toBe('/studio/w2/render');
    expect(details.G4?.redirectTo).toBe('/publish/w2');
  });

  it('G3 无在途任务时同样按 workId 隔离', () => {
    expect(detailsOf(emptyWork(OTHER_WORK_ID)).G3?.redirectTo).toBe('/studio/w2/video');
  });

  it('任何详情路径都不残留 :id / [id] 占位', () => {
    for (const id of [WORK_ID, OTHER_WORK_ID]) {
      for (const d of Object.values(detailsOf(emptyWork(id), RENDER_JOB_ID))) {
        expect(d?.redirectTo).not.toContain(':id');
        expect(d?.redirectTo).not.toContain('[id]');
      }
    }
  });
});

describe('deriveParallelHint 真值表：job × G2 × G3 全 8 格（D-07 / 架构 §5.4 / §5.6）', () => {
  for (const job of [null, RENDER_JOB_ID]) {
    for (const G2 of [false, true]) {
      for (const G3 of [false, true]) {
        const enabled = job !== null && G2 && !G3;
        const gates: Gates = { G1: true, G2, G3, G4: false };
        it(`job=${job ?? 'null'} G2=${G2} G3=${G3} → enabled=${enabled}`, () => {
          const hint = deriveParallelHint(truth(), gates, job);
          expect(hint.enabled).toBe(enabled);
          if (enabled) {
            expect(hint.cta).toBe(HINT_CTA);
            expect(hint.redirectTo).toBe('/publish/w1');
          } else {
            expect(hint).toEqual(NO_HINT);
          }
          expect(ParallelHintSchema.parse(hint)).toEqual(hint);
        });
      }
    }
  }

  it('渲染完成（G3=true）后不再提示并行，即使 job 仍在途', () => {
    const gates: Gates = { G1: true, G2: true, G3: true, G4: true };
    expect(deriveParallelHint(allSatisfied(), gates, RENDER_JOB_ID)).toEqual(NO_HINT);
  });

  it('未确认文案（G2=false）时不提示：metadata 派生本身就要 G2（架构 §5.4）', () => {
    const gates: Gates = { G1: true, G2: false, G3: false, G4: false };
    expect(deriveParallelHint(truth(), gates, RENDER_JOB_ID)).toEqual(NO_HINT);
  });

  it('G1/G4 不影响提示（只取决于渲染在途 + G2 + 非 G3）', () => {
    const gates: Gates = { G1: false, G2: true, G3: false, G4: true };
    expect(deriveParallelHint(truth(), gates, RENDER_JOB_ID).enabled).toBe(true);
  });

  it('CTA 落地页是派生页 /publish/:id（SPEC §2.5 page-publish）', () => {
    const gates: Gates = { G1: true, G2: true, G3: false, G4: false };
    expect(deriveParallelHint(truth(), gates, RENDER_JOB_ID).redirectTo).toBe('/publish/w1');
    expect(deriveParallelHint(emptyWork(OTHER_WORK_ID), gates, RENDER_JOB_ID).redirectTo).toBe(
      '/publish/w2',
    );
  });
});

describe('纯函数性（架构 §3.2）', () => {
  it('快照与 gates 被深冻结后仍可派生，且不被修改', () => {
    const s = deepFreeze(emptyWork());
    const gates = deepFreeze(deriveGates(s));
    const before = JSON.stringify(s);
    expect(Object.keys(deriveGateDetails(s, gates, RENDER_JOB_ID))).toEqual(['G1', 'G2', 'G3', 'G4']);
    expect(deriveParallelHint(s, gates, RENDER_JOB_ID).enabled).toBe(false);
    expect(JSON.stringify(s)).toBe(before);
  });

  it('重复调用结果恒定，且每次返回新对象（不共享可变引用）', () => {
    const s = emptyWork();
    const gates = deriveGates(s);
    const a = deriveGateDetails(s, gates, RENDER_JOB_ID);
    const b = deriveGateDetails(s, gates, RENDER_JOB_ID);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(a.G3).not.toBe(b.G3);
  });
});