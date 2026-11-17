import { describe, expect, it } from 'vitest';
import { GatesSchema, WorkEnvelopeSchema } from '../src/dto.js';
import type { GateReason } from '../src/dto.js';
import type { GateId } from '../src/enums.js';

/**
 * gates 与 gateDetails 的一致性闸门（架构 §5.6）。
 *
 * 缺陷形状：前端 gateViewOf 把「缺详情」读成已满足，于是 gates[g]=false 而
 * gateDetails[g] 缺失的漂移响应会让未满足的门渲染成已解锁（D-04 根因形状）。
 * 服务端仍是闸门权威，故不是提权，但「首帧即锁定态」的验收会静默失效。
 *
 * 本文件**刻意不 import domain / apps**：.dependency-cruiser.cjs 的
 * contracts-is-leaf(:90-95) 与 packages-never-import-apps(:83-88) 都没有 test/ 豁免，
 * 跨包正向联动（真实 deriveGateDetails 产出、真实 gateViewOf）改用仓库外探针取证，
 * 见 review/t05-envelope-gate-consistency.md。
 */
const GATES = GatesSchema.keyof().options;

const REDIRECT: Record<GateId, string> = {
  G1: '/studio/w_probe/topics',
  G2: '/studio/w_probe/script',
  G3: '/studio/w_probe/video',
  G4: '/publish/w_probe/export',
};

const REASON: Record<GateId, GateReason> = {
  G1: 'TOPIC_NOT_SELECTED',
  G2: 'SCRIPT_NOT_CONFIRMED',
  G3: 'HD_RENDER_NOT_SUCCEEDED',
  G4: 'COMPLIANCE_REPORT_MISSING',
};

type Detail = { satisfied: boolean; reason: GateReason; redirectTo: string; activeJobId?: string };

/** 全门满足、详情为空——与 apps/web fixtures 的 w3 同形，是合法生产者输出。 */
const BASE = {
  id: 'w_probe',
  title: '探针作品',
  keyword: '探针',
  phase: 1,
  step: 'script',
  progress: 50,
  selectedTopicId: 't01',
  scriptConfirmedAt: null,
  activeRenderJobId: null,
  parallelHint: { enabled: false, cta: '', redirectTo: '/studio/w_probe/script' },
  quota: { total: 60, used: 1, reserved: 0, left: 59, resetAt: '2026-12-01T00:00:00Z' },
};

/** 按 domain deriveGateDetails 的规则构造：每个未满足的门都配一条 satisfied:false 详情。 */
function envelopeWithUnsatisfied(unsatisfied: readonly GateId[]) {
  const gates: Record<GateId, boolean> = { G1: true, G2: true, G3: true, G4: true };
  const gateDetails: Partial<Record<GateId, Detail>> = {};
  for (const gate of unsatisfied) {
    gates[gate] = false;
    gateDetails[gate] = { satisfied: false, reason: REASON[gate], redirectTo: REDIRECT[gate] };
  }
  return { ...BASE, gates, gateDetails };
}

function issuesOf(input: unknown) {
  const result = WorkEnvelopeSchema.safeParse(input);
  return result.success ? [] : result.error.issues;
}

describe('闸门一致性：gates[g]=false 必须有 satisfied:false 的详情', () => {
  it.each(GATES)('门 %s：缺详情必须被拒，且错误定位到该门', (gate) => {
    const consistent = envelopeWithUnsatisfied([gate]);
    // 先证明构造出的合法态真的能过——否则下面的失败可能来自无关字段，属「恰好为绿」的反面。
    expect(WorkEnvelopeSchema.safeParse(consistent).success).toBe(true);
    expect(consistent.gates[gate]).toBe(false);
    expect(consistent.gateDetails[gate]?.satisfied).toBe(false);

    delete consistent.gateDetails[gate];
    // 确认漂移态真的构造出来了：布尔位仍是 false，详情真的没了。
    expect(consistent.gates[gate]).toBe(false);
    expect(consistent.gateDetails[gate]).toBeUndefined();

    const issues = issuesOf(consistent);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toEqual(['gateDetails', gate]);
  });

  it('极端漂移：四个门全 false 而 gateDetails={} → 一次报出四个门', () => {
    const drifted = { ...envelopeWithUnsatisfied(GATES), gateDetails: {} };
    expect(Object.values(drifted.gates).every((v) => v === false)).toBe(true);

    const issues = issuesOf(drifted);
    expect(issues).toHaveLength(4);
    expect(issues.map((i) => i.path)).toEqual(GATES.map((g) => ['gateDetails', g]));
  });

  it('实证过的 w2 漂移形状：G2/G3/G4 未满足而详情全空 → 三个门各自报错', () => {
    const drifted = {
      ...envelopeWithUnsatisfied(['G2', 'G3', 'G4']),
      gateDetails: {},
    };
    const issues = issuesOf(drifted);
    expect(issues.map((i) => i.path)).toEqual([
      ['gateDetails', 'G2'],
      ['gateDetails', 'G3'],
      ['gateDetails', 'G4'],
    ]);
  });

  it('漂移只在一致性上失败，不夹带其它校验错误', () => {
    const drifted = { ...envelopeWithUnsatisfied(GATES), gateDetails: {} };
    const issues = issuesOf(drifted);
    // 先断言非空：否则 refine 被摘掉时下面的 for 循环会空转，测试「恰好为绿」。
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(issue.code).toBe('custom');
      expect(issue.path[0]).toBe('gateDetails');
    }
  });
});

describe('闸门一致性：反向与容许边界', () => {
  it.each(GATES)('门 %s：gates=true 但详情 satisfied=false 是矛盾态，必须被拒', (gate) => {
    const contradictory = envelopeWithUnsatisfied([]);
    contradictory.gateDetails[gate] = {
      satisfied: false,
      reason: REASON[gate],
      redirectTo: REDIRECT[gate],
    };
    expect(contradictory.gates[gate]).toBe(true);
    expect(contradictory.gateDetails[gate]?.satisfied).toBe(false);

    const issues = issuesOf(contradictory);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toEqual(['gateDetails', gate]);
  });

  it.each(GATES)('门 %s：gates=false 但详情 satisfied=true 同样被拒', (gate) => {
    const lying = envelopeWithUnsatisfied([gate]);
    lying.gateDetails[gate] = { satisfied: true, reason: REASON[gate], redirectTo: REDIRECT[gate] };
    expect(issuesOf(lying).map((i) => i.path)).toEqual([['gateDetails', gate]]);
  });

  it.each(GATES)('门 %s：gates=true 且详情 satisfied=true 允许存在（不发明「必须缺席」）', (gate) => {
    // 架构 §5.6 只有示例（arch:1235-1238），无「已满足门详情必须缺席」的明文；
    // domain 从不产出这种详情，但凭空禁止会收紧出未经裁决的形状。故只要求两者不矛盾。
    const tolerant = envelopeWithUnsatisfied([]);
    tolerant.gateDetails[gate] = { satisfied: true, reason: REASON[gate], redirectTo: REDIRECT[gate] };
    expect(WorkEnvelopeSchema.safeParse(tolerant).success).toBe(true);
  });

  it('全门满足 + 空详情可解析（合法生产者输出，加固没把正常态卡死）', () => {
    expect(WorkEnvelopeSchema.safeParse(envelopeWithUnsatisfied([])).success).toBe(true);
  });

  it('全门未满足 + 四条详情可解析', () => {
    expect(WorkEnvelopeSchema.safeParse(envelopeWithUnsatisfied(GATES)).success).toBe(true);
  });
});

describe('闸门一致性：错误信息不得回写详情内容', () => {
  it('message 只含门号与不一致性质，不含 reason/redirectTo/activeJobId', () => {
    const leaked = envelopeWithUnsatisfied([]);
    leaked.gates.G3 = true;
    leaked.gateDetails.G3 = {
      satisfied: false,
      reason: 'HD_RENDER_NOT_SUCCEEDED',
      redirectTo: '/studio/w_probe/render',
      activeJobId: 'job_secret_88',
    };
    const issues = issuesOf(leaked);
    expect(issues).toHaveLength(1);
    const message = issues[0]?.message ?? '';
    expect(message).toContain('G3');
    expect(message).not.toContain('job_secret_88');
    expect(message).not.toContain('/studio/w_probe/render');
    expect(message).not.toContain('HD_RENDER_NOT_SUCCEEDED');
  });
});

describe('架构 §5.6 示例自身漏了 G4 详情（规则赢、示例错）', () => {
  /**
   * arch:1234 的 gates 是 {G1:true,G2:true,G3:false,G4:false}，
   * 而 arch:1235-1238 的 gateDetails 只给了 G3 —— G4=false 却无详情，
   * 违反 §5.6 自己声明的「只装未满足的门」。
   * 旁证：apps/web/src/work/fixtures.ts:19 的 gates 与示例逐字相同，
   * 但 :20-32 同时给了 G3 与 G4，前端作者已独立补齐。
   * 本测试把「示例原样不可解析」钉住，arch 示例需补一行，归架构 owner。
   */
  const archExampleVerbatim = {
    ...BASE,
    id: 'w1',
    phase: 2,
    step: 'video.rendering',
    progress: 70,
    gates: { G1: true, G2: true, G3: false, G4: false },
    gateDetails: {
      G3: {
        satisfied: false,
        reason: 'HD_RENDER_NOT_SUCCEEDED' as GateReason,
        redirectTo: '/studio/w1/render',
        activeJobId: 'job_88',
      },
    },
    selectedTopicId: 't03',
    scriptConfirmedAt: '2026-11-12T10:12:03Z',
    activeRenderJobId: 'job_88',
    parallelHint: { enabled: true, cta: '渲染时你可以先去写平台标题', redirectTo: '/publish/w1' },
    quota: { total: 60, used: 22, reserved: 2, left: 36, resetAt: '2026-12-01T00:00:00Z' },
  };

  it('示例原样（缺 G4 详情）被拒，错误指向 gateDetails.G4', () => {
    const issues = issuesOf(archExampleVerbatim);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toEqual(['gateDetails', 'G4']);
  });

  it('按 §5.6 规则补齐 G4 详情后即可解析（证明卡的只是缺失，不是别的字段）', () => {
    const completed = {
      ...archExampleVerbatim,
      gateDetails: {
        ...archExampleVerbatim.gateDetails,
        G4: {
          satisfied: false,
          reason: 'COMPLIANCE_REPORT_MISSING' as GateReason,
          redirectTo: '/publish/w1',
        },
      },
    };
    expect(WorkEnvelopeSchema.safeParse(completed).success).toBe(true);
  });
});