/** ⑩ 配额账本（架构 §4.4 875–925 行）。不变量 left = total - used - reserved。 */
import type { QuotaAction, ReservationState } from '@knowstudio/contracts';
import type {
  BigIntStr,
  DbGenerated,
  Defaulted,
  Id,
  Nullable,
  UtcDateTime,
} from './column-types.js';

export interface QuotaAccountTable {
  user_id: Id;
  plan_id: string;
  /** CHECK ck_quota_total: total >= 0。 */
  total: number;
  /** CHECK ck_quota_used: used >= 0。 */
  used: Defaulted<number>;
  /** CHECK ck_quota_reserved: reserved >= 0。 */
  reserved: Defaulted<number>;
  reset_at: UtcDateTime;
  /** 乐观锁备用，主用行锁。 */
  version: Defaulted<BigIntStr>;
}

export interface QuotaReservationTable {
  id: Id;
  user_id: Id;
  work_id: Id;
  job_id: Nullable<Id>;
  /** CHECK ck_rsv_points: points > 0。 */
  points: number;
  state: Defaulted<ReservationState>;
  /** 兜底自动释放（worker 失联）。 */
  expires_at: UtcDateTime;
  created_at: Defaulted<UtcDateTime>;
  settled_at: Nullable<UtcDateTime>;
}

export interface QuotaLedgerTable {
  id: DbGenerated<BigIntStr>;
  user_id: Id;
  work_id: Nullable<Id>;
  job_id: Nullable<Id>;
  reservation_id: Nullable<Id>;
  action: QuotaAction;
  /** 恒为正，方向由 action 决定（架构 §7.2）。 */
  points: number;
  /** 该时刻 left 快照。 */
  balance_after: number;
  idempotency_key: Nullable<string>;
  note: Nullable<string>;
  created_at: Defaulted<UtcDateTime>;
}