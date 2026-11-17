import type { WorkTruthSnapshot } from '@knowstudio/contracts';
import { complianceFingerprint } from '../src/gates/fingerprint.js';

/**
 * 基线取自 SPEC §4.3 种子（w1 费曼学习法 / 选第 3 个角度 t03 / k1+k4 均为「知乎·可商用」）
 * 与架构 §5.6 信封示例（scriptConfirmedAt=2026-11-12T10:12:03Z、activeRenderJobId=job_88）。
 * 「四门全满足」的条件以架构 §5.2 的合取式为准，G4 的指纹一致性以架构 §8.4 为准。
 */
export const WORK_ID = 'w1';
export const OTHER_WORK_ID = 'w2';
export const TOPIC_ID = 't03';
export const CONFIRMED_AT = '2026-11-12T10:12:03Z';
export const RENDER_JOB_ID = 'job_88';
export const SCRIPT_VERSION = 3;

export function truth(over: Partial<WorkTruthSnapshot> = {}): WorkTruthSnapshot {
  return {
    workId: WORK_ID,
    selectedTopicId: TOPIC_ID,
    script: {
      id: 'sc1',
      version: SCRIPT_VERSION,
      status: 'confirmed',
      confirmedAt: CONFIRMED_AT,
      contentHash: 'hash-v3',
    },
    latestHdAsset: { id: 'va1', status: 'succeeded', stale: false, scriptVersion: SCRIPT_VERSION },
    latestCompliance: null,
    materials: [
      { materialId: 'k1', license: 'cleared', licenseEvidenceVersion: 1 },
      { materialId: 'k4', license: 'cleared', licenseEvidenceVersion: 1 },
    ],
    derivatives: [
      {
        platformId: 'douyin',
        ruleVersion: 3,
        title: '费曼学习法：为什么你学了就忘',
        tags: ['学习方法', '费曼'],
      },
      { platformId: 'bili', ruleVersion: 3, title: '费曼学习法拆解', tags: ['学习', '干货'] },
    ],
    template: { templateId: 'tpl1', version: 2, fontFamily: '思源黑体' },
    bgm: { trackId: 'bgm1', evidenceExpiresAt: '2027-01-01T00:00:00Z' },
    lexiconVersion: 7,
    ...over,
  };
}

/** 架构 §8.4：报告指纹与当前真相一致时 G4 才可能满足；blockingCount 由合规引擎给出。 */
export function withReport(s: WorkTruthSnapshot, blockingCount = 0): WorkTruthSnapshot {
  return { ...s, latestCompliance: { blockingCount, fingerprint: complianceFingerprint(s) } };
}

/** 架构 §5.2 四个合取式全部成立。 */
export function allSatisfied(): WorkTruthSnapshot {
  return withReport(truth());
}

/** 架构 §5.1「创建 Work → search」：全新上下文，不继承任何旧 Work 数据（D-05）。 */
export function emptyWork(workId: string = WORK_ID): WorkTruthSnapshot {
  return truth({
    workId,
    selectedTopicId: null,
    script: null,
    latestHdAsset: null,
    latestCompliance: null,
    materials: [],
    derivatives: [],
    template: null,
    bgm: null,
    lexiconVersion: 1,
  });
}

/** 纯函数测试用：任何就地修改都会在严格模式下抛错，而不是静默污染后续用例。 */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const v of Object.values(value as unknown as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}