import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type { WorkTruthSnapshot } from '@knowstudio/contracts';

/**
 * 架构 §8.4 合规报告指纹。G4 用它防陈旧放行：报告存在且 blockingCount=0
 * 还不够，指纹必须与当前真相一致，否则改了素材/文案/规则后旧报告会放行导出。
 *
 * 七组输入按固定顺序规范化为 JSON 再哈希：排序保证同一真相得到同一指纹，
 * 显式 null 保证「没有 BGM」与「BGM 为空串」不会碰撞。
 * 用 @noble/hashes 而非 node:crypto，因为 domain 必须能在浏览器运行。
 */
export function complianceFingerprint(s: WorkTruthSnapshot): string {
  const materials = [...s.materials]
    .sort((a, b) => (a.materialId < b.materialId ? -1 : a.materialId > b.materialId ? 1 : 0))
    .map((m) => [m.materialId, m.license, m.licenseEvidenceVersion]);

  const derivatives = [...s.derivatives]
    .sort((a, b) => (a.platformId < b.platformId ? -1 : a.platformId > b.platformId ? 1 : 0))
    .map((d) => [d.platformId, d.ruleVersion, d.title, d.tags]);

  const canonical = [
    materials,
    s.script?.version ?? null,
    s.script?.contentHash ?? null,
    derivatives,
    s.template === null ? null : `${s.template.templateId}@${s.template.version}`,
    s.template?.fontFamily ?? null,
    s.bgm?.trackId ?? null,
    s.bgm?.evidenceExpiresAt ?? null,
    s.lexiconVersion,
  ];

  return bytesToHex(sha256(utf8ToBytes(JSON.stringify(canonical))));
}