/** ⑥ 分层资产与视频 + ⑦ 渲染任务（架构 §4.4 692–790 行）。 */
import type { AssetQuality, JobStatus, JobType, LayerKind } from '@knowstudio/contracts';
import type {
  BigIntStr,
  Bool,
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
import type { Orient } from './db-enums.js';
import type { AssetLayerMeta } from './json-shapes.js';

export interface AssetLayerTable {
  id: Id;
  work_id: Id;
  user_id: Id;
  kind: LayerKind;
  version: number;
  /** 内容寻址：命中即复用。 */
  content_hash: string;
  storage_key: string;
  meta: JsonColDefaulted<AssetLayerMeta>;
  /** 决定该层内容的全部输入之哈希；uq_layer_reuse 的复用键。 */
  input_fingerprint: string;
  duration_ms: Nullable<number>;
  created_at: Defaulted<UtcDateTime>;
}

export interface VideoAssetTable {
  id: Id;
  work_id: Id;
  user_id: Id;
  quality: AssetQuality;
  status: Defaulted<JobStatus>;
  storage_key: Nullable<string>;
  duration_ms: Nullable<number>;
  /** 854x480 / 1920x1080 / 3840x2160。 */
  resolution: Nullable<string>;
  orient: Nullable<Orient>;
  template_id: Nullable<string>;
  voice_id: Nullable<string>;
  speed: Defaulted<DecimalStr>;
  script_version: number;
  /** 母版变更后置 1（SPEC §3.4）。 */
  stale: Defaulted<Bool>;
  created_at: Defaulted<UtcDateTime>;
}

export interface VideoAssetLayerTable {
  video_asset_id: Id;
  layer_id: Id;
}

export interface RenderJobTable {
  id: Id;
  work_id: Id;
  user_id: Id;
  type: JobType;
  layer_scope: JsonColDefaulted;
  status: Defaulted<JobStatus>;
  /** CHECK ck_job_progress: BETWEEN 0 AND 100。 */
  progress: Defaulted<number>;
  /** queued|tts|slides|align|mux|finalize。 */
  stage: Nullable<string>;
  cost_points: Defaulted<number>;
  reservation_id: Nullable<Id>;
  video_asset_id: Nullable<Id>;
  /** NULL 幂等键在唯一索引中互不相等，无需生成列。 */
  idempotency_key: Nullable<string>;
  attempt: Defaulted<number>;
  error: JsonColNullable;
  cancel_requested: Defaulted<Bool>;
  started_at: Nullable<UtcDateTime>;
  finished_at: Nullable<UtcDateTime>;
  created_at: Defaulted<UtcDateTime>;
  /**
   * ★并发上限 1/用户：STORED 生成列
   * AS (IF(status IN ('queued','running') AND type IN ('draft','hd','patch'), 1, NULL))
   * 配合 uq_active_render_per_user(user_id, active_render_flag) 实现条件唯一。
   * 这是本项目**唯一**阻止「同一用户两条渲染同时烧 CPU」的防线。
   */
  active_render_flag: DbGenerated<1 | null>;
}

export interface RenderJobEventTable {
  id: DbGenerated<BigIntStr>;
  job_id: Id;
  /** uq_event_seq(job_id, seq)：SSE Last-Event-ID 回放依据。 */
  seq: number;
  /** progress|stage|status|quota|done|error。 */
  event_type: string;
  payload: JsonCol;
  created_at: Defaulted<UtcDateTime>;
}