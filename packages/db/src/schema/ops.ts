/** ⑭ 其余支撑表（架构 §4.4 987–1041 行）。 */
import type {
  BigIntStr,
  Bool,
  DbGenerated,
  DecimalStr,
  Defaulted,
  Id,
  JsonColDefaulted,
  JsonColNullable,
  Nullable,
  UtcDateTime,
} from './column-types.js';

export interface IdempotencyRecordTable {
  user_id: Id;
  /** KEY 是 MySQL 保留字，DDL 中反引号包裹。 */
  key: string;
  request_hash: string;
  status_code: Nullable<number>;
  response: JsonColNullable;
  created_at: Defaulted<UtcDateTime>;
}

export interface AnalyticsEventTable {
  id: DbGenerated<BigIntStr>;
  user_id: Id;
  work_id: Nullable<Id>;
  /** SPEC §11 事件名。 */
  event: string;
  props: JsonColDefaulted;
  occurred_at: UtcDateTime;
  ingested_at: Defaulted<UtcDateTime>;
}

export interface AiCallLogTable {
  id: DbGenerated<BigIntStr>;
  user_id: Nullable<Id>;
  work_id: Nullable<Id>;
  job_id: Nullable<Id>;
  port: string;
  provider: string;
  model: string;
  input_tokens: Nullable<number>;
  output_tokens: Nullable<number>;
  audio_chars: Nullable<number>;
  /** DECIMAL(10,4)：成本用精确小数，禁止浮点。 */
  cost_cny: Nullable<DecimalStr>;
  latency_ms: Nullable<number>;
  cache_hit: Defaulted<Bool>;
  fallback_from: Nullable<string>;
  created_at: Defaulted<UtcDateTime>;
}

export interface AuditLogTable {
  id: DbGenerated<BigIntStr>;
  user_id: Id;
  work_id: Nullable<Id>;
  /** script.confirm / export.create / gate.denied。 */
  action: string;
  target: Nullable<string>;
  payload: JsonColNullable;
  /** 原 inet；IPv6 文本形式。 */
  ip: Nullable<string>;
  created_at: Defaulted<UtcDateTime>;
}