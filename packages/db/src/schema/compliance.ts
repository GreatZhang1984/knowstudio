/** ⑨ 合规与导出（架构 §4.4 839–872 行）。G4 硬门与 G5「永不自动发布」的数据落点。 */
import type { JobStatus } from '@knowstudio/contracts';
import type {
  BigIntStr,
  Defaulted,
  Id,
  JsonCol,
  JsonColDefaulted,
  Nullable,
  UtcDateTime,
} from './column-types.js';
import type { ComplianceItem } from './json-shapes.js';

export interface ComplianceReportTable {
  id: Id;
  work_id: Id;
  user_id: Id;
  items: JsonCol<ComplianceItem[]>;
  blocking_count: number;
  warn_count: Defaulted<number>;
  /** G4 防陈旧放行（架构 §8.4）；uq_compliance_fp(work_id, fingerprint)。 */
  fingerprint: string;
  checked_at: Defaulted<UtcDateTime>;
}

export interface ExportPackageTable {
  id: Id;
  work_id: Id;
  user_id: Id;
  status: Defaulted<JobStatus>;
  files: JsonColDefaulted;
  manifest_key: Nullable<string>;
  /** 发布清单.md —— 只输出参数清单，系统永不代发（G5）。 */
  checklist_key: Nullable<string>;
  package_key: Nullable<string>;
  package_size: Nullable<BigIntStr>;
  report_id: Nullable<Id>;
  /** 签名 24h；产物保留 ≥7 天。 */
  expires_at: UtcDateTime;
  created_at: Defaulted<UtcDateTime>;
}