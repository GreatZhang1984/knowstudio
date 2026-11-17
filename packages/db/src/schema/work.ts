/** ② Work 核心上下文 + ③ 素材与引用（架构 §4.4 470–541 行）。 */
import type { LicenseState, MaterialType, WorkStep } from '@knowstudio/contracts';
import type { Defaulted, Id, JsonColDefaulted, JsonColNullable, Nullable, UtcDateTime } from './column-types.js';
import type { GatesCache, LicenseEvidence, UsedInEntry } from './json-shapes.js';

export interface WorkTable {
  id: Id;
  user_id: Id;
  title: string;
  keyword: Nullable<string>;
  /** CHECK ck_work_phase: BETWEEN 0 AND 4。 */
  phase: Defaulted<number>;
  step: Defaulted<WorkStep>;
  /** G1 真相。**故意不建 FK**（避免 work↔topic↔render_job 循环依赖）。 */
  selected_topic_id: Nullable<Id>;
  /** G2 真相。 */
  script_confirmed_at: Nullable<UtcDateTime>;
  /** 同样故意不建 FK。 */
  active_render_job_id: Nullable<Id>;
  /** 读缓存；权威判定走 domain.deriveGates。 */
  gates: JsonColDefaulted<GatesCache>;
  gates_fingerprint: Nullable<string>;
  exported_at: Nullable<UtcDateTime>;
  deleted_at: Nullable<UtcDateTime>;
  created_at: Defaulted<UtcDateTime>;
  updated_at: Defaulted<UtcDateTime>;
}

export interface MaterialTable {
  id: Id;
  /** NULL = 全局公共库。 */
  user_id: Nullable<Id>;
  type: MaterialType;
  title: string;
  source: string;
  source_url: Nullable<string>;
  source_color: Nullable<string>;
  meta: JsonColDefaulted;
  /** 供搬运检测 LCS 比对。 */
  body_text: Nullable<string>;
  storage_key: Nullable<string>;
  license: Defaulted<LicenseState>;
  license_evidence: JsonColNullable<LicenseEvidence>;
  tags: JsonColDefaulted<string[]>;
  fetched_at: Nullable<UtcDateTime>;
  deleted_at: Nullable<UtcDateTime>;
  created_at: Defaulted<UtcDateTime>;
}

export interface WorkMaterialTable {
  work_id: Id;
  material_id: Id;
  /** 冗余列，用于隔离校验与合规批量查询。 */
  user_id: Id;
  collected_at: Defaulted<UtcDateTime>;
  used_in: JsonColDefaulted<UsedInEntry[]>;
}