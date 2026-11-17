import { describe, expect, it } from 'vitest';
import {
  GatesSchema,
  JobStatus,
  ScriptStatus,
  type Gates,
  type WorkTruthSnapshot,
} from '@knowstudio/contracts';
import { deriveGates } from '../../src/index.js';
import {
  CONFIRMED_AT,
  SCRIPT_VERSION,
  TOPIC_ID,
  allSatisfied,
  deepFreeze,
  emptyWork,
  truth,
  withReport,
} from '../fixtures.js';

/**
 * 期望值抄自架构 §5.2「闸门是派生值，不是存储位」的四个合取式与真相来源表
 * （spark-output/architecture/knowledge-video-tool.md:1135-1155），
 * 以及 SPEC §2.3 人工把关门表（spec/knowledge-video-tool.md:133-139）。
 * G4 的「指纹必须与当前真相一致」见架构 §8.4（arch:1697-1707）。
 * 门彼此独立、G5 不是可派生的门，见 SPEC §2.3 与契约 GateId 注释。
 */
const STALE_FINGERPRINT = '0'.repeat(64);
const ALL_FALSE: Gates = { G1: false, G2: false, G3: false, G4: false };
const ALL_TRUE: Gates = { G1: true, G2: true, G3: true, G4: true };

const scriptOf = (
  status: 'draft' | 'confirmed' | 'stale',
  confirmedAt: string | null,
): NonNullable<WorkTruthSnapshot['script']> => ({
  id: 'sc1',
  version: SCRIPT_VERSION,
  status,
  confirmedAt,
  contentHash: 'hash-v3',
});

describe('G1：selectedTopicId != null（SPEC §2.3 / 架构 §5.2 真相来源 work.selected_topic_id）', () => {
  it('未选题 → 不满足', () => {
    expect(deriveGates(truth({ selectedTopicId: null })).G1).toBe(false);
  });

  it('已选第 3 个角度 t03（SPEC §4.3 种子）→ 满足', () => {
    expect(deriveGates(truth({ selectedTopicId: TOPIC_ID })).G1).toBe(true);
  });

  it('重新选题只是缓存失效触发，条件仍是「有选中」→ 满足', () => {
    expect(deriveGates(truth({ selectedTopicId: 't05' })).G1).toBe(true);
  });

  it('只看选题，不要求文案/成片/合规：全新 Work 选完题即 G1=true', () => {
    expect(deriveGates({ ...emptyWork(), selectedTopicId: TOPIC_ID })).toEqual({
      ...ALL_FALSE,
      G1: true,
    });
  });

  it('其余三门全满足也不能替代选题', () => {
    const s = { ...allSatisfied(), selectedTopicId: null };
    expect(deriveGates(s)).toEqual({ ...ALL_TRUE, G1: false });
  });
});

describe('G2：script.status=confirmed 且 confirmedAt != null（SPEC §2.3 / 架构 §5.2）', () => {
  it('无文案 → 不满足', () => {
    expect(deriveGates(truth({ script: null })).G2).toBe(false);
  });

  for (const status of ScriptStatus.values) {
    for (const confirmedAt of [null, CONFIRMED_AT]) {
      const expected = status === 'confirmed' && confirmedAt !== null;
      it(`status=${status} confirmedAt=${confirmedAt === null ? 'null' : '有值'} → ${expected}`, () => {
        expect(deriveGates(truth({ script: scriptOf(status, confirmedAt) })).G2).toBe(expected);
      });
    }
  }

  it('只有时间戳没有 confirmed 状态不放行（SPEC §3.4：modal 二次确认后才落库）', () => {
    expect(deriveGates(truth({ script: scriptOf('draft', CONFIRMED_AT) })).G2).toBe(false);
  });

  it('stale 文案不放行（解锁后母版失效，SPEC §3.4）', () => {
    expect(deriveGates(truth({ script: scriptOf('stale', CONFIRMED_AT) })).G2).toBe(false);
  });

  it('G2 不依赖 G1：未选题但文案已确认时 G2 仍为 true（门彼此独立）', () => {
    const gates = deriveGates(truth({ selectedTopicId: null, script: scriptOf('confirmed', CONFIRMED_AT) }));
    expect(gates.G1).toBe(false);
    expect(gates.G2).toBe(true);
  });
});

describe('G3：最新 hd 资产 succeeded 且非 stale 且 scriptVersion 一致（架构 §5.2 四项合取）', () => {
  it('无成片 → 不满足', () => {
    expect(deriveGates(truth({ latestHdAsset: null })).G3).toBe(false);
  });

  for (const status of JobStatus.values) {
    for (const stale of [false, true]) {
      for (const versionMatch of [true, false]) {
        const expected = status === 'succeeded' && !stale && versionMatch;
        const label = `status=${status} stale=${stale} 版本${versionMatch ? '一致' : '不一致'}`;
        it(`${label} → ${expected}`, () => {
          const s = truth({
            latestHdAsset: {
              id: 'va1',
              status,
              stale,
              scriptVersion: versionMatch ? SCRIPT_VERSION : SCRIPT_VERSION + 1,
            },
          });
          expect(deriveGates(s).G3).toBe(expected);
        });
      }
    }
  }

  it('渲染在途（running）不放行：SPEC §2.3「请先完成高清渲染」', () => {
    const s = truth({
      latestHdAsset: { id: 'va1', status: 'running', stale: false, scriptVersion: SCRIPT_VERSION },
      latestCompliance: null,
    });
    expect(deriveGates(s)).toEqual({ G1: true, G2: true, G3: false, G4: false });
  });

  it('stale=true 一票否决（SPEC §3.4：解锁后已渲染视频标记 stale）', () => {
    const s = truth({
      latestHdAsset: { id: 'va1', status: 'succeeded', stale: true, scriptVersion: SCRIPT_VERSION },
    });
    expect(deriveGates(s).G3).toBe(false);
  });

  it('母版版本变更后旧成片不得放行（架构 §5.2 G3 失效触发：母版变更）', () => {
    const s = truth({ script: { ...scriptOf('confirmed', CONFIRMED_AT), version: SCRIPT_VERSION + 1 } });
    expect(deriveGates(s).G3).toBe(false);
  });

  it('文案被删除时成片版本无从比对 → 不满足', () => {
    expect(deriveGates(truth({ script: null })).G3).toBe(false);
  });

  it('G3 不要求文案处于 confirmed：门各判各的真相（架构 §5.2）', () => {
    const s = truth({ script: scriptOf('draft', null) });
    expect(deriveGates(s).G2).toBe(false);
    expect(deriveGates(s).G3).toBe(true);
  });
});

describe('G4：报告存在 + blockingCount=0 + 指纹与当前真相一致（SPEC §2.3 / 架构 §8.4）', () => {
  it('无合规报告 → 不满足', () => {
    expect(deriveGates(truth({ latestCompliance: null })).G4).toBe(false);
  });

  for (const blockingCount of [0, 1, 3]) {
    for (const fresh of [true, false]) {
      const expected = blockingCount === 0 && fresh;
      it(`blockingCount=${blockingCount} 指纹${fresh ? '一致' : '陈旧'} → ${expected}`, () => {
        const base = truth();
        const s: WorkTruthSnapshot = {
          ...base,
          latestCompliance: {
            blockingCount,
            fingerprint: fresh ? withReport(base).latestCompliance!.fingerprint : STALE_FINGERPRINT,
          },
        };
        expect(deriveGates(s).G4).toBe(expected);
      });
    }
  }

  it('blockingCount=0 但指纹陈旧仍不放行（D-04 根因：原型信任硬编码 ok:true）', () => {
    const s = truth({ latestCompliance: { blockingCount: 0, fingerprint: STALE_FINGERPRINT } });
    expect(deriveGates(s).G4).toBe(false);
  });

  it('SPEC §12.2 QA 剧本：报告通过后又引入需授权素材 k3 → 旧报告不得放行导出', () => {
    const before = withReport(truth());
    expect(deriveGates(before).G4).toBe(true);
    const after: WorkTruthSnapshot = {
      ...before,
      materials: [...before.materials, { materialId: 'k3', license: 'restricted', licenseEvidenceVersion: 1 }],
    };
    expect(deriveGates(after).G4).toBe(false);
  });

  it('移除 k3 后复检通过 → G4 恢复（SPEC §12.2「移除 k3 → 复检通过 → 打包下载」）', () => {
    const withK3 = truth({
      materials: [
        { materialId: 'k1', license: 'cleared', licenseEvidenceVersion: 1 },
        { materialId: 'k3', license: 'restricted', licenseEvidenceVersion: 1 },
      ],
    });
    expect(deriveGates(withReport(withK3, 1)).G4).toBe(false);
    const fixed = truth();
    expect(deriveGates(withReport(fixed)).G4).toBe(true);
  });

  it('G4 不依赖 G1/G2/G3：全新 Work 只有一份一致的空报告时 G4 仍可为 true', () => {
    expect(deriveGates(withReport(emptyWork()))).toEqual({ ...ALL_FALSE, G4: true });
  });

  it('有阻断项时即使指纹一致也不放行（SPEC §8.5「任一 block 项存在 → 禁止导出」）', () => {
    expect(deriveGates(withReport(truth(), 1)).G4).toBe(false);
  });
});

describe('整体派生：组合、契约与纯函数性', () => {
  it('全新 Work（架构 §5.1 创建 Work → search）四门全 false', () => {
    expect(deriveGates(emptyWork())).toEqual(ALL_FALSE);
  });

  it('四门全满足的基线', () => {
    expect(deriveGates(allSatisfied())).toEqual(ALL_TRUE);
  });

  it('SPEC §5 响应示例（spec:572）：step=script 时 gates = {G1:true,G2:false,G3:false,G4:false}', () => {
    const s = truth({
      script: scriptOf('draft', null),
      latestHdAsset: null,
      latestCompliance: null,
    });
    expect(deriveGates(s)).toEqual({ G1: true, G2: false, G3: false, G4: false });
  });

  it('架构 §5.6 信封示例（arch:1231）：渲染在途时 gates = {G1:true,G2:true,G3:false,G4:false}', () => {
    const s = truth({
      latestHdAsset: { id: 'va1', status: 'running', stale: false, scriptVersion: SCRIPT_VERSION },
      latestCompliance: null,
    });
    expect(deriveGates(s)).toEqual({ G1: true, G2: true, G3: false, G4: false });
  });

  it('解锁文案（架构 §5.1 副作用）：G2/G3/G4 全部失效，G1 保留', () => {
    const unlocked = truth({
      script: { id: 'sc1', version: SCRIPT_VERSION + 1, status: 'draft', confirmedAt: null, contentHash: 'hash-v4' },
      latestHdAsset: { id: 'va1', status: 'succeeded', stale: true, scriptVersion: SCRIPT_VERSION },
      latestCompliance: { blockingCount: 0, fingerprint: STALE_FINGERPRINT },
    });
    expect(deriveGates(unlocked)).toEqual({ G1: true, G2: false, G3: false, G4: false });
  });

  it('输出恰好 G1–G4 四个布尔，不含 G5（SPEC §2.3：G5 是静态禁令不是门）', () => {
    const gates = deriveGates(allSatisfied());
    expect(Object.keys(gates)).toEqual(['G1', 'G2', 'G3', 'G4']);
    for (const v of Object.values(gates)) expect(typeof v).toBe('boolean');
    expect('G5' in gates).toBe(false);
  });

  it('输出满足契约 GatesSchema（架构 §5.6 信封）', () => {
    for (const s of [emptyWork(), allSatisfied(), truth(), withReport(truth(), 2)]) {
      expect(GatesSchema.parse(deriveGates(s))).toEqual(deriveGates(s));
    }
  });

  it('确定性：同一真相多次派生结果相同，与对象身份无关', () => {
    const a = allSatisfied();
    const b = JSON.parse(JSON.stringify(a)) as WorkTruthSnapshot;
    expect(deriveGates(a)).toEqual(deriveGates(b));
    expect(deriveGates(a)).toEqual(deriveGates(a));
  });

  it('纯函数：不修改快照（冻结后仍可派生）', () => {
    const s = deepFreeze(allSatisfied());
    const before = JSON.stringify(s);
    expect(deriveGates(s)).toEqual(ALL_TRUE);
    expect(JSON.stringify(s)).toBe(before);
  });

  it('权威判定只看快照：快照里没有客户端传入的 gates/reportId 字段可用（D-04 对策）', () => {
    const forged = {
      ...emptyWork(),
      gates: ALL_TRUE,
      reportId: 'r-forged',
      ok: true,
    } as unknown as WorkTruthSnapshot;
    expect(deriveGates(forged)).toEqual(ALL_FALSE);
  });
});