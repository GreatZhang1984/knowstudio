/**
 * JSON 列的已知形状（架构 §4.4 列注释 + SPEC §5 响应示例）。
 *
 * 只描述**架构明写**的键；未明写的一律留在 JsonValue，不自行发明字段。
 * 这些类型是「读取侧便利」，DB 层并不校验 JSON 内部结构（值域由 contracts 的 zod 保证）。
 */
import type { ComplianceKind, ComplianceState, GateId, PlatformId } from '@knowstudio/contracts';
import type { JsonValue } from './column-types.js';

/** work.gates：读缓存，权威判定走 domain.deriveGates（架构 §4.3.4）。 */
export type GatesCache = Record<GateId, boolean>;

/** app_user.default_platforms 默认 ["douyin","sph","bili","xhs"]。 */
export type PlatformIdList = PlatformId[];

/** work_material.used_in：[{target:'slides',pageId:'p2'},{target:'script',lineId:'l3'}]。 */
export interface UsedInEntry {
  target: string;
  pageId?: string;
  lineId?: string;
}

/** material.license_evidence：{type,url,expiresAt,uploadedAt}。 */
export interface LicenseEvidence {
  type?: string;
  url?: string;
  expiresAt?: string;
  uploadedAt?: string;
  [key: string]: JsonValue | undefined;
}

/** search_session.saturation：{score,level,confidence,sampleSize,coveredPlatforms[],sources[]}。 */
export interface Saturation {
  score?: number;
  level?: string;
  confidence?: number;
  sampleSize?: number;
  coveredPlatforms?: string[];
  sources?: JsonValue[];
  [key: string]: JsonValue | undefined;
}

/** compliance_report.items：[{kind,status,detail,blocking,materialIds[],fixHint}]。 */
export interface ComplianceItem {
  kind: ComplianceKind;
  status: ComplianceState;
  detail?: string;
  blocking: boolean;
  materialIds?: string[];
  fixHint?: string;
}

/** script_revision.diff：[{lineId,before,after}]。 */
export interface ScriptDiffEntry {
  lineId: string;
  before: string;
  after: string;
}

/** asset_layer.meta：audio:{voiceId,speed,segments[]} slides:{templateId,pages[]}。 */
export interface AssetLayerMeta {
  voiceId?: string;
  speed?: number;
  segments?: JsonValue[];
  templateId?: string;
  pages?: JsonValue[];
  [key: string]: JsonValue | undefined;
}