/** ④ 搜索与选题 + ⑪ 热点（架构 §4.4 544–601、928–941 行）。 */
import type { JobStatus, TrendLifecycle } from '@knowstudio/contracts';
import type {
  DbGenerated,
  DecimalStr,
  Defaulted,
  Id,
  JsonCol,
  JsonColDefaulted,
  JsonColNullable,
  Nullable,
  UtcDateTime,
} from './column-types.js';
import type { Saturation } from './json-shapes.js';

export interface SearchSessionTable {
  id: Id;
  work_id: Id;
  user_id: Id;
  keyword: string;
  /** STORED 生成列 AS (MD5(keyword))：不可插入/更新。 */
  keyword_hash: DbGenerated<string>;
  domain: Nullable<string>;
  status: Defaulted<JobStatus>;
  saturation: JsonColNullable<Saturation>;
  blank_angles: JsonColDefaulted;
  material_ids: JsonColDefaulted<string[]>;
  /** 单源失败明细（partial 态）。 */
  partial_errors: JsonColDefaulted;
  duration_ms: Nullable<number>;
  cache_hit: Defaulted<0 | 1>;
  created_at: Defaulted<UtcDateTime>;
}

export interface TopicBatchTable {
  id: Id;
  work_id: Id;
  user_id: Id;
  batch_index: number;
  based_on_material_ids: JsonCol<string[]>;
  /** 跨批去重依据（D-09）。 */
  hook_fingerprints: JsonColDefaulted<string[]>;
  min_pairwise_cosine: Nullable<DecimalStr>;
  /** 上限 2（SPEC §6.2）。 */
  regen_attempts: Defaulted<number>;
  /** 差异不足时明示有效数量。 */
  effective_count: number;
  created_at: Defaulted<UtcDateTime>;
}

export interface TopicTable {
  id: Id;
  batch_id: Id;
  work_id: Id;
  hook: string;
  angle: string;
  blank_point: string;
  /** CHECK ck_topic_basis: JSON_LENGTH >= 1。 */
  basis_material_ids: JsonCol<string[]>;
  diversity_score: Nullable<DecimalStr>;
  /**
   * MySQL 8 无 VECTOR 类型：JSON 存 1024 维 float，cosine 在应用层算。
   * CHECK ck_topic_emb_dim: NULL 或 JSON_LENGTH = 1024。
   */
  embedding: JsonColNullable<number[]>;
  hook_fingerprint: string;
  ord: number;
}

export interface TrendTable {
  id: Id;
  domain: string;
  name: string;
  heat: Nullable<DecimalStr>;
  lifecycle: TrendLifecycle;
  window_hours: Nullable<number>;
  angles: JsonColDefaulted;
  source: string;
  fetched_at: UtcDateTime;
  created_at: Defaulted<UtcDateTime>;
}