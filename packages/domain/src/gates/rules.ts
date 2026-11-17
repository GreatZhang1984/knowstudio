import type { Gates, WorkTruthSnapshot } from '@knowstudio/contracts';
import { complianceFingerprint } from './fingerprint.js';

/**
 * 架构 §5.2：闸门是派生值，不是存储位。work.gates 只是读缓存，
 * 权威判定永远从 WorkTruthSnapshot 重算——这是 D-04（原型硬编码 ok:true）的根因对策。
 */
export function deriveGates(s: WorkTruthSnapshot): Gates {
  return {
    G1: s.selectedTopicId != null,
    G2: s.script?.status === 'confirmed' && s.script.confirmedAt != null,
    G3:
      s.latestHdAsset != null &&
      s.latestHdAsset.status === 'succeeded' &&
      !s.latestHdAsset.stale &&
      s.latestHdAsset.scriptVersion === s.script?.version,
    G4:
      s.latestCompliance != null &&
      s.latestCompliance.blockingCount === 0 &&
      s.latestCompliance.fingerprint === complianceFingerprint(s),
  };
}