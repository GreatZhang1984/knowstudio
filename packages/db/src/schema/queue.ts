/** ⑫ 自研持久队列 + ⑬ 指标聚合（架构 §4.4 944–984 行，v1.1 新增）。 */
import type { QueueState } from '@knowstudio/contracts';
import type {
  BigIntStr,
  DbGenerated,
  DecimalStr,
  Defaulted,
  Id,
  JsonColDefaulted,
  JsonColNullable,
  Nullable,
  UtcDateTime,
} from './column-types.js';

export interface JobQueueTable {
  id: DbGenerated<BigIntStr>;
  /**
   * render.draft / render.hd / render.patch / derive.media / export.pack
   * / ai.search / ai.topics / ai.script / sys.sweep / sys.metric
   */
  queue: string;
  /** 关联 render_job.id；系统任务为 NULL。 */
  job_id: Nullable<Id>;
  user_id: Nullable<Id>;
  payload: JsonColDefaulted;
  state: Defaulted<QueueState>;
  /** 退避延迟可见时间。 */
  run_after: Defaulted<UtcDateTime>;
  attempt: Defaulted<number>;
  max_attempt: Defaulted<number>;
  /** worker 实例 ID（hostname+pid+bootId）。 */
  lease_owner: Nullable<string>;
  /** 租约到期 → Sweeper 重投。 */
  lease_expires_at: Nullable<UtcDateTime>;
  /** fencing token，防僵尸 worker 写回。 */
  lease_token: Defaulted<BigIntStr>;
  /** 自然键幂等（同 work+type+指纹）；NULL 互不相等。 */
  dedup_key: Nullable<string>;
  last_error: JsonColNullable;
  created_at: Defaulted<UtcDateTime>;
  started_at: Nullable<UtcDateTime>;
  finished_at: Nullable<UtcDateTime>;
}

/** 替代物化视图：每小时调度 job 增量 upsert（架构 §4.3.3）。 */
export interface MetricSnapshotTable {
  /** g1_e2e_p50 / g6_cost_per_work ... */
  metric: string;
  scope: Defaulted<string>;
  /** global 用 '-' 占位。 */
  scope_id: Defaulted<Id>;
  /** 小时对齐。 */
  bucket: UtcDateTime;
  value_num: DecimalStr;
  sample_n: Defaulted<number>;
  computed_at: Defaulted<UtcDateTime>;
}