import { describe, expect, it } from 'vitest';
import {
  ApiErrorSchema,
  DeriveScope,
  GateId,
  GateNotSatisfied,
  GateReason,
  GatesSchema,
  httpStatusOf,
  type Gates,
  type WorkTruthSnapshot,
} from '@knowstudio/contracts';
import { GATED_ACTIONS, deriveGates, type GateAction } from '@knowstudio/domain';
import { checkGate, checkGateById, type GateCheckResult } from '../src/index.js';
import {
  CONFIRMED_AT,
  RENDER_JOB_ID,
  SCRIPT_VERSION,
  allSatisfied,
  deepFreeze,
  emptyWork,
  rendering,
  truth,
  withReport,
} from './fixtures.js';

/**
 * 期望值抄自：
 * - 架构 §5.3 路由门标注表（architecture/knowledge-video-tool.md:1189-1199）与时序图
 *   「409 GATE_NOT_SATISFIED requiredGate=G2 redirectTo=/studio/w1/script」（arch:1178）；
 * - 架构 §5.4 派生二分表（arch:1205-1208）+ §10.3「缺省 media」（arch:1871）；
 * - 架构 §5.6 信封示例的 gateDetails / parallelHint（arch:1226-1241）；
 * - 架构 §8.4「绝不接受客户端传来的 reportId 作为放行依据」（arch:1707，D-04 根因）；
 * - SPEC §5 通用约定「闸门失败统一 409 GATE_NOT_SATISFIED { requiredGate, redirectTo }」（spec:547）；
 * - SPEC §2.3 门表（spec:133-139）、SPEC §2.5 路由表（spec:174-193）；
 * - 契约 ERROR_HTTP_STATUS.GATE_NOT_SATISFIED=409 与 GateNotSatisfied.details 三字段。
 * 修复入口路径按 SPEC §2.5 代入 w1；G3 在渲染在途时指向渲染中心（架构 §5.6）。
 */
const DOC_GATE: Record<GateAction, GateId> = {
  'script:generate': 'G1',
  'video:draft': 'G2',
  'video:render': 'G2',
  'video:patch': 'G2',
  'derivatives:generate': 'G3',
  'derivatives:patch': 'G2',
  'export': 'G4',
};

const DOC_REDIRECT: Record<GateId, string> = {
  G1: '/discover/topics',
  G2: '/studio/w1/script',
  G3: '/studio/w1/video',
  G4: '/publish/w1',
};

const DOC_REASON: Record<GateId, GateReason> = {
  G1: 'TOPIC_NOT_SELECTED',
  G2: 'SCRIPT_NOT_CONFIRMED',
  G3: 'HD_RENDER_NOT_SUCCEEDED',
  G4: 'COMPLIANCE_REPORT_MISSING',
};

const ALL_TRUE: Gates = { G1: true, G2: true, G3: true, G4: true };
const STALE_FINGERPRINT = '0'.repeat(64);

/** 只缺一个门的快照：用于逐门验证「未满足直调 API」与「满足即放行」。 */
const MISSING: Record<GateId, WorkTruthSnapshot> = {
  G1: { ...allSatisfied(), selectedTopicId: null },
  G2: { ...allSatisfied(), script: { ...truth().script!, status: 'draft', confirmedAt: null } },
  G3: { ...allSatisfied(), latestHdAsset: null },
  G4: { ...allSatisfied(), latestCompliance: null },
};

function denied(r: GateCheckResult): Extract<GateCheckResult, { ok: false }> {
  if (r.ok) throw new Error(`期望 409 拒绝，实际放行：${JSON.stringify(r.gates)}`);
  return r;
}

function allowed(r: GateCheckResult): Extract<GateCheckResult, { ok: true }> {
  if (!r.ok) throw new Error(`期望放行，实际被拒：${r.error.code} ${JSON.stringify(r.error.details)}`);
  return r;
}

describe('夹具自检：MISSING 恰好只缺一个门（架构 §5.2 四门独立）', () => {
  for (const gate of GateId.values) {
    it(`MISSING.${gate} 只有 ${gate}=false`, () => {
      const expected: Gates = {
        G1: gate !== 'G1',
        G2: gate !== 'G2',
        G3: gate !== 'G3',
        G4: gate !== 'G4',
      };
      expect(deriveGates(MISSING[gate])).toEqual(expected);
    });
  }
});

describe('T-12 验收：G1–G4 各一条「未满足直调 API」→ 409 且含 redirectTo', () => {
  it('G1：未选题直调 script:generate → 409 G1 + /discover/topics', () => {
    const r = denied(checkGate(emptyWork(), 'script:generate'));
    expect(r.status).toBe(409);
    expect(r.error.code).toBe('GATE_NOT_SATISFIED');
    expect(r.error.details).toEqual({
      requiredGate: 'G1',
      redirectTo: '/discover/topics',
      reason: 'TOPIC_NOT_SELECTED',
    });
    expect(r.gates).toEqual({ G1: false, G2: false, G3: false, G4: false });
  });

  it('G2：未确认文案直调 video:render → 409 G2 + /studio/w1/script（AC-S6 含服务端）', () => {
    const r = denied(checkGate(MISSING.G2, 'video:render'));
    expect(r.status).toBe(409);
    expect(r.error.details).toEqual({
      requiredGate: 'G2',
      redirectTo: '/studio/w1/script',
      reason: 'SCRIPT_NOT_CONFIRMED',
    });
    expect(r.gates).toEqual({ ...ALL_TRUE, G2: false });
  });

  it('G3：未完成高清渲染直调 derivatives:generate → 409 G3 + /studio/w1/video', () => {
    const r = denied(checkGate(MISSING.G3, 'derivatives:generate'));
    expect(r.status).toBe(409);
    expect(r.error.details).toEqual({
      requiredGate: 'G3',
      redirectTo: '/studio/w1/video',
      reason: 'HD_RENDER_NOT_SUCCEEDED',
    });
    expect(r.gates).toEqual({ ...ALL_TRUE, G3: false });
  });

  it('G4：合规有阻断项直调 export → 409 G4 + /publish/w1（AC-E4；修复入口是派生页，不得自指）', () => {
    const r = denied(checkGate(withReport(truth(), 1), 'export'));
    expect(r.status).toBe(409);
    expect(r.error.details).toEqual({
      requiredGate: 'G4',
      redirectTo: '/publish/w1',
      reason: 'COMPLIANCE_BLOCKING',
    });
    expect(r.gates).toEqual({ ...ALL_TRUE, G4: false });
  });

  it('四条拒绝都带非空 redirectTo（SPEC §5：闸门失败必带 requiredGate 与 redirectTo）', () => {
    const results = [
      checkGate(emptyWork(), 'script:generate'),
      checkGate(MISSING.G2, 'video:draft'),
      checkGate(MISSING.G3, 'derivatives:generate'),
      checkGate(MISSING.G4, 'export'),
    ];
    for (const r of results) {
      const d = denied(r);
      expect(d.error.details.requiredGate).toBeTruthy();
      expect(d.error.details.redirectTo.length).toBeGreaterThan(0);
    }
  });
});

describe('架构 §5.3 门标注经 checkGate 端到端生效：7 动作 × 2 scope', () => {
  for (const action of GATED_ACTIONS) {
    for (const scope of DeriveScope.values) {
      const gate: GateId =
        action === 'derivatives:generate' && scope === 'metadata' ? 'G2' : DOC_GATE[action];

      it(`${action} scope=${scope}：只缺 ${gate} 时被拒且 requiredGate=${gate}`, () => {
        const r = denied(checkGate(MISSING[gate], action, scope));
        expect(r.status).toBe(409);
        expect(r.error.details.requiredGate).toBe(gate);
        expect(r.error.details.redirectTo).toBe(DOC_REDIRECT[gate]);
        expect(r.error.details.reason).toBe(DOC_REASON[gate]);
      });

      it(`${action} scope=${scope}：四门全满足时放行`, () => {
        const r = allowed(checkGate(allSatisfied(), action, scope));
        expect(r.gates).toEqual(ALL_TRUE);
        expect(r).not.toHaveProperty('status');
        expect(r).not.toHaveProperty('error');
      });
    }
  }

  it('缺省 scope 与 media 判定完全一致（架构 §10.3）', () => {
    for (const action of GATED_ACTIONS) {
      expect(checkGate(MISSING.G3, action)).toEqual(checkGate(MISSING.G3, action, 'media'));
      expect(checkGate(allSatisfied(), action)).toEqual(checkGate(allSatisfied(), action, 'media'));
    }
  });

  it('每道门只拦自己的路由：缺 G1 不影响 video:draft（门彼此独立）', () => {
    expect(denied(checkGate(MISSING.G1, 'script:generate')).error.details.requiredGate).toBe('G1');
    expect(allowed(checkGate(MISSING.G1, 'video:draft')).gates).toEqual({ ...ALL_TRUE, G1: false });
    expect(allowed(checkGate(MISSING.G1, 'export')).gates).toEqual({ ...ALL_TRUE, G1: false });
  });

  it('缺 G3 不影响导出以外的 G2 路由，也不影响 metadata 派生', () => {
    expect(allowed(checkGate(MISSING.G3, 'video:patch')).gates.G3).toBe(false);
    expect(allowed(checkGate(MISSING.G3, 'derivatives:patch')).gates.G3).toBe(false);
    expect(allowed(checkGate(MISSING.G3, 'derivatives:generate', 'metadata')).gates.G3).toBe(false);
  });
});

describe('checkGateById：四门逐一判定（架构 §5.2 权威判定走 deriveGates）', () => {
  for (const gate of GateId.values) {
    it(`${gate} 未满足 → 409，requiredGate=${gate}`, () => {
      const r = denied(checkGateById(MISSING[gate], gate));
      expect(r.status).toBe(409);
      expect(r.error.details.requiredGate).toBe(gate);
      expect(r.error.details.redirectTo).toBe(DOC_REDIRECT[gate]);
      expect(r.error.details.reason).toBe(DOC_REASON[gate]);
    });

    it(`${gate} 满足 → 放行并回传四门真相`, () => {
      expect(allowed(checkGateById(allSatisfied(), gate)).gates).toEqual(ALL_TRUE);
    });

    it(`${gate}：全新 Work 一律拒绝`, () => {
      expect(denied(checkGateById(emptyWork(), gate)).error.details.requiredGate).toBe(gate);
    });
  }

  it('checkGate 与 checkGateById 对同一门给出同一结果', () => {
    for (const action of GATED_ACTIONS) {
      for (const scope of DeriveScope.values) {
        const gate: GateId =
          action === 'derivatives:generate' && scope === 'metadata' ? 'G2' : DOC_GATE[action];
        expect(checkGate(MISSING[gate], action, scope)).toEqual(checkGateById(MISSING[gate], gate));
      }
    }
  });
});

describe('D-07：渲染在途可并行做 metadata，media 仍被 G3 拦（架构 §5.4 / §6.4）', () => {
  it('渲染在途快照的门真相 = {G1:true,G2:true,G3:false,G4:false}（架构 §5.6 示例）', () => {
    expect(deriveGates(rendering())).toEqual({ G1: true, G2: true, G3: false, G4: false });
  });

  it('scope=metadata 放行（仅需 G2）', () => {
    expect(allowed(checkGate(rendering(), 'derivatives:generate', 'metadata', RENDER_JOB_ID)).gates).toEqual(
      { G1: true, G2: true, G3: false, G4: false },
    );
  });

  it('scope=media 被拒，且 redirectTo 指向渲染中心 /studio/w1/render', () => {
    const r = denied(checkGate(rendering(), 'derivatives:generate', 'media', RENDER_JOB_ID));
    expect(r.error.details).toEqual({
      requiredGate: 'G3',
      redirectTo: '/studio/w1/render',
      reason: 'HD_RENDER_NOT_SUCCEEDED',
    });
  });

  it('漏传 scope 按 media 拦（宁可多校验一道门）', () => {
    const r = denied(checkGate(rendering(), 'derivatives:generate', undefined, RENDER_JOB_ID));
    expect(r.error.details.requiredGate).toBe('G3');
  });

  it('渲染在途时改平台标题（derivatives:patch）放行：只需 G2', () => {
    expect(allowed(checkGate(rendering(), 'derivatives:patch', 'media', RENDER_JOB_ID)).gates.G2).toBe(true);
  });

  it('渲染完成后 media 派生放行（G3 满足）', () => {
    expect(allowed(checkGate(allSatisfied(), 'derivatives:generate', 'media', RENDER_JOB_ID)).gates).toEqual(
      ALL_TRUE,
    );
  });

  it('G2 未满足时 metadata 也拦：并行前提是文案已确认（架构 §5.4）', () => {
    const r = denied(checkGate(MISSING.G2, 'derivatives:generate', 'metadata', RENDER_JOB_ID));
    expect(r.error.details.requiredGate).toBe('G2');
    expect(r.error.details.redirectTo).toBe('/studio/w1/script');
  });
});

describe('D-04 根因对策：只信快照，不信客户端传入的 gates / reportId（架构 §8.4）', () => {
  it('快照上附加伪造的 gates / reportId / ok 字段不能放行', () => {
    const forged = {
      ...emptyWork(),
      gates: ALL_TRUE,
      reportId: 'r-forged',
      ok: true,
      compliance: { blockingCount: 0, fingerprint: STALE_FINGERPRINT },
    } as unknown as WorkTruthSnapshot;
    for (const action of GATED_ACTIONS) {
      const r = denied(checkGate(forged, action));
      expect(r.gates).toEqual({ G1: false, G2: false, G3: false, G4: false });
      expect(r.status).toBe(409);
    }
  });

  it('报告指纹来自旧版本真相（文案改字前）→ 409 G4 指纹陈旧', () => {
    const oldReport = withReport(
      truth({ script: { ...truth().script!, contentHash: 'hash-v2' } }),
    ).latestCompliance!;
    const s = truth({ latestCompliance: oldReport });
    const r = denied(checkGate(s, 'export'));
    expect(r.error.details.requiredGate).toBe('G4');
    expect(r.error.details.reason).toBe('COMPLIANCE_FINGERPRINT_STALE');
  });

  it('报告说 blockingCount=0，但真相里已引入需授权素材 k3 → 仍 409（SPEC §12.2 QA 剧本）', () => {
    const reported = withReport(truth());
    const s: WorkTruthSnapshot = {
      ...reported,
      materials: [...reported.materials, { materialId: 'k3', license: 'restricted', licenseEvidenceVersion: 1 }],
    };
    const r = denied(checkGate(s, 'export'));
    expect(r.error.details.reason).toBe('COMPLIANCE_FINGERPRINT_STALE');
    expect(r.error.details.redirectTo).toBe('/publish/w1');
  });

  it('指纹一致但有阻断项 → 409 COMPLIANCE_BLOCKING（SPEC §8.5）', () => {
    const r = denied(checkGate(withReport(truth(), 2), 'export'));
    expect(r.error.details.reason).toBe('COMPLIANCE_BLOCKING');
  });

  it('完全没有报告 → 409 COMPLIANCE_REPORT_MISSING，不得默认放行', () => {
    const r = denied(checkGate(truth({ latestCompliance: null }), 'export'));
    expect(r.error.details.reason).toBe('COMPLIANCE_REPORT_MISSING');
  });

  it('解锁文案后母版陈旧：G2/G3/G4 同时拦（架构 §5.1 副作用）', () => {
    const unlocked = truth({
      script: { id: 'sc1', version: SCRIPT_VERSION + 1, status: 'draft', confirmedAt: null, contentHash: 'hash-v4' },
      latestHdAsset: { id: 'va1', status: 'succeeded', stale: true, scriptVersion: SCRIPT_VERSION },
      latestCompliance: { blockingCount: 0, fingerprint: STALE_FINGERPRINT },
    });
    expect(denied(checkGate(unlocked, 'video:render')).error.details.requiredGate).toBe('G2');
    expect(denied(checkGate(unlocked, 'derivatives:generate')).error.details.requiredGate).toBe('G3');
    expect(denied(checkGate(unlocked, 'export')).error.details.requiredGate).toBe('G4');
    expect(allowed(checkGate(unlocked, 'script:generate')).gates.G1).toBe(true);
  });

  it('成片 stale 但文案仍确认：G3 拦而 G2 放行（SPEC §3.4 标记 stale）', () => {
    const s = truth({
      latestHdAsset: { id: 'va1', status: 'succeeded', stale: true, scriptVersion: SCRIPT_VERSION },
    });
    expect(allowed(checkGate(s, 'video:render')).gates.G2).toBe(true);
    const r = denied(checkGate(s, 'derivatives:generate'));
    expect(r.error.details.reason).toBe('HD_ASSET_STALE');
  });
});

describe('409 契约形状（SPEC §5 通用 / 架构 §10.2 / 契约 GateNotSatisfied）', () => {
  const samples: readonly GateCheckResult[] = [
    checkGate(emptyWork(), 'script:generate'),
    checkGate(MISSING.G2, 'video:draft'),
    checkGate(MISSING.G3, 'derivatives:generate', 'media', RENDER_JOB_ID),
    checkGate(withReport(truth(), 1), 'export'),
    checkGateById(emptyWork(), 'G4'),
  ];

  it('status 恒为 409，且与契约 ERROR_HTTP_STATUS 同源', () => {
    expect(httpStatusOf('GATE_NOT_SATISFIED')).toBe(409);
    for (const s of samples) expect(denied(s).status).toBe(httpStatusOf('GATE_NOT_SATISFIED'));
  });

  it('error 能被契约 GateNotSatisfied 与 ApiErrorSchema 解析', () => {
    for (const s of samples) {
      const { error } = denied(s);
      expect(GateNotSatisfied.parse(error)).toEqual(error);
      expect(ApiErrorSchema.parse(error)).toEqual(error);
    }
  });

  it('details 恰好 requiredGate / redirectTo / reason 三键', () => {
    for (const s of samples) {
      expect(Object.keys(denied(s).error.details).sort()).toEqual([
        'reason',
        'redirectTo',
        'requiredGate',
      ]);
    }
  });

  it('requiredGate 落在 G1–G4，reason 落在契约 GateReason 值域', () => {
    for (const s of samples) {
      const d = denied(s).error.details;
      expect(GateId.safeParse(d.requiredGate).success).toBe(true);
      expect(GateReason.safeParse(d.reason).success).toBe(true);
      expect(d.requiredGate).not.toBe('G5');
    }
  });

  it('message 是非空字符串（前端按 code 分支，不解析 message，架构 §10.1）', () => {
    for (const s of samples) {
      const { message } = denied(s).error;
      expect(typeof message).toBe('string');
      expect(message.length).toBeGreaterThan(0);
    }
  });

  it('拒绝时也回传四门真相，且满足 GatesSchema（前端一次拿全真相，架构 §5.5）', () => {
    for (const s of samples) {
      const r = denied(s);
      expect(GatesSchema.parse(r.gates)).toEqual(r.gates);
      expect(Object.keys(r.gates)).toEqual(['G1', 'G2', 'G3', 'G4']);
    }
  });

  it('放行结果只有 ok 与 gates 两键', () => {
    for (const action of GATED_ACTIONS) {
      expect(Object.keys(allowed(checkGate(allSatisfied(), action))).sort()).toEqual(['gates', 'ok']);
    }
  });
});

describe('redirectTo 与 activeRenderJobId 联动（架构 §5.6）', () => {
  it('G3：无在途任务 → 视频页；有在途任务 → 渲染中心', () => {
    expect(denied(checkGate(MISSING.G3, 'derivatives:generate')).error.details.redirectTo).toBe(
      '/studio/w1/video',
    );
    expect(
      denied(checkGate(MISSING.G3, 'derivatives:generate', 'media', RENDER_JOB_ID)).error.details.redirectTo,
    ).toBe('/studio/w1/render');
  });

  it('G1/G2/G4 的修复入口不受在途任务影响', () => {
    for (const [action, gate] of [
      ['script:generate', 'G1'],
      ['video:draft', 'G2'],
      ['export', 'G4'],
    ] as const) {
      expect(denied(checkGate(MISSING[gate], action, 'media', RENDER_JOB_ID)).error.details.redirectTo).toBe(
        DOC_REDIRECT[gate],
      );
    }
  });

  it('另一个 Work 的 redirectTo 指向自己的路由（D-01 / D-05）', () => {
    const w2 = emptyWork('w2');
    expect(denied(checkGate(w2, 'script:generate')).error.details.redirectTo).toBe('/discover/topics');
    expect(denied(checkGate(w2, 'video:draft')).error.details.redirectTo).toBe('/studio/w2/script');
    expect(denied(checkGate(w2, 'derivatives:generate')).error.details.redirectTo).toBe('/studio/w2/video');
    expect(denied(checkGate(w2, 'export')).error.details.redirectTo).toBe('/publish/w2');
    expect(
      denied(checkGate(w2, 'derivatives:generate', 'media', RENDER_JOB_ID)).error.details.redirectTo,
    ).toBe('/studio/w2/render');
  });

  it('任何 redirectTo 都不残留 :id / [id] 占位', () => {
    for (const gate of GateId.values) {
      for (const job of [null, RENDER_JOB_ID]) {
        const url = denied(checkGateById(emptyWork(), gate, job)).error.details.redirectTo;
        expect(url).not.toContain(':id');
        expect(url).not.toContain('[id]');
      }
    }
  });
});

describe('纯函数性与确定性（架构 §5.3：快照由调用方一次聚合取得，判定零 IO）', () => {
  it('快照被深冻结后仍可判定，且内容不变', () => {
    const s = deepFreeze(allSatisfied());
    const before = JSON.stringify(s);
    expect(allowed(checkGate(s, 'export')).gates).toEqual(ALL_TRUE);
    expect(JSON.stringify(s)).toBe(before);
  });

  it('拒绝路径同样不修改快照', () => {
    const s = deepFreeze(emptyWork());
    const before = JSON.stringify(s);
    expect(denied(checkGate(s, 'export')).status).toBe(409);
    expect(JSON.stringify(s)).toBe(before);
  });

  it('重复调用结果恒定，与对象身份无关', () => {
    const a = emptyWork();
    const b = JSON.parse(JSON.stringify(a)) as WorkTruthSnapshot;
    expect(checkGate(a, 'export')).toEqual(checkGate(b, 'export'));
    expect(checkGate(a, 'export')).toEqual(checkGate(a, 'export'));
  });

  it('每次返回新对象，调用方修改结果不会污染下一次判定', () => {
    const s = allSatisfied();
    const first = allowed(checkGate(s, 'export'));
    first.gates.G1 = false;
    expect(allowed(checkGate(s, 'export')).gates).toEqual(ALL_TRUE);
  });

  it('判定结果与快照真相一致：gates 就是 deriveGates 的输出（架构 §5.2 权威判定）', () => {
    for (const s of [emptyWork(), truth(), rendering(), allSatisfied(), withReport(truth(), 1)]) {
      for (const action of GATED_ACTIONS) {
        expect(checkGate(s, action).gates).toEqual(deriveGates(s));
      }
    }
  });

  it('confirmedAt 有值但 status 仍是 draft → G2 拦（SPEC §3.4 二次确认后才落库）', () => {
    const s = truth({ script: { ...truth().script!, status: 'draft', confirmedAt: CONFIRMED_AT } });
    const r = denied(checkGate(s, 'video:draft'));
    expect(r.error.details.requiredGate).toBe('G2');
    expect(r.error.details.reason).toBe('SCRIPT_NOT_CONFIRMED');
  });
});