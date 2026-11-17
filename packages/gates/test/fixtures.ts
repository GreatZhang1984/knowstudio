import type { WorkTruthSnapshot } from '@knowstudio/contracts';
import { complianceFingerprint } from '@knowstudio/domain';

/**
 * 基线取自 SPEC §4.3 种子（w1 费曼学习法 / t03 / k1+k4 可商用）与架构 §5.6 信封示例
 * （scriptConfirmedAt=2026-11-12T10:12:03Z、activeRenderJobId=job_88）。
 * 「四门全满足」的条件见架构 §5.2；报告指纹一致性见架构 §8.4。
 */
export const WORK_ID = 'w1';
export const CONFIRMED_AT = '2026-11-12T10:12:03Z';
export const RENDER_JOB_ID = 'job_88';
export const SCRIPT_VERSION = 3;

export function truth(over: Partial<WorkTruthSnapshot> = {}): WorkTruthSnapshot {
  return {
    workId: WORK_ID,
    selectedTopicId: 't03',
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
      { platformId: 'douyin', ruleVersion: 3, title: '费曼学习法：为什么你学了就忘', tags: ['学习方法'] },
      { platformId: 'bili', ruleVersion: 3, title: '费曼学习法拆解', tags: ['学习', '干货'] },
    ],
    template: { templateId: 'tpl1', version: 2, fontFamily: '思源黑体' },
    bgm: { trackId: 'bgm1', evidenceExpiresAt: '2027-01-01T00:00:00Z' },
    lexiconVersion: 7,
    ...over,
  };
}

/** 架构 §8.4：报告指纹必须等于当前真相的指纹，G4 才可能满足。 */
export function withReport(s: WorkTruthSnapshot, blockingCount = 0): WorkTruthSnapshot {
  return { ...s, latestCompliance: { blockingCount, fingerprint: complianceFingerprint(s) } };
}

export function allSatisfied(): WorkTruthSnapshot {
  return withReport(truth());
}

/** 架构 §5.1「创建 Work → search」：全新上下文，四门全 false。 */
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

/** 架构 §5.6 示例态：文案已确认、高清渲染在途、尚无合规报告。 */
export function rendering(): WorkTruthSnapshot {
  return truth({
    latestHdAsset: { id: 'va1', status: 'running', stale: false, scriptVersion: SCRIPT_VERSION },
    latestCompliance: null,
  });
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const v of Object.values(value as unknown as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}