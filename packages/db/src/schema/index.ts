/**
 * Kysely `Database` 类型：**恰好 36 张表**（24 实体 + 12 支撑）。
 *
 * 表名与列名逐一对齐架构 §4.4；运行时表名清单在 `migrations/tables.ts`，
 * 二者的一致性由 test/schema-invariant.test.ts 做**编译期**双向断言。
 *
 * 不含任何会话表：会话/refresh token 存 Redis（客户 2026-11-13 拍板），
 * 也不含 kysely_migration / kysely_migration_lock（内置 Migrator 被禁用）。
 */
import type {
  AppUserTable,
  StyleProfileTable,
  StyleSampleTable,
  UserSourceConfigTable,
} from './user.js';
import type { MaterialTable, WorkMaterialTable, WorkTable } from './work.js';
import type { SearchSessionTable, TopicBatchTable, TopicTable, TrendTable } from './discover.js';
import type {
  ScriptLineTable,
  ScriptRevisionTable,
  ScriptSectionTable,
  ScriptTable,
  ScriptVariantTable,
  StyleHunkTable,
} from './script.js';
import type {
  AssetLayerTable,
  RenderJobEventTable,
  RenderJobTable,
  VideoAssetLayerTable,
  VideoAssetTable,
} from './media.js';
import type { DerivativeTable, PlatformRuleTable } from './derivative.js';
import type { ComplianceReportTable, ExportPackageTable } from './compliance.js';
import type { QuotaAccountTable, QuotaLedgerTable, QuotaReservationTable } from './quota.js';
import type { JobQueueTable, MetricSnapshotTable } from './queue.js';
import type {
  AiCallLogTable,
  AnalyticsEventTable,
  AuditLogTable,
  IdempotencyRecordTable,
} from './ops.js';
import type { TemplateCatalogTable, VoiceCatalogTable } from './catalog.js';

export interface Database {
  // ① 用户与风格
  app_user: AppUserTable;
  style_sample: StyleSampleTable;
  style_profile: StyleProfileTable;
  user_source_config: UserSourceConfigTable;
  // ② Work
  work: WorkTable;
  // ③ 素材与引用
  material: MaterialTable;
  work_material: WorkMaterialTable;
  // ④ 搜索与选题
  search_session: SearchSessionTable;
  topic_batch: TopicBatchTable;
  topic: TopicTable;
  // ⑤ 文案
  script: ScriptTable;
  script_section: ScriptSectionTable;
  script_line: ScriptLineTable;
  script_revision: ScriptRevisionTable;
  style_hunk: StyleHunkTable;
  script_variant: ScriptVariantTable;
  // ⑥ 分层资产与视频
  asset_layer: AssetLayerTable;
  video_asset: VideoAssetTable;
  video_asset_layer: VideoAssetLayerTable;
  // ⑦ 渲染任务
  render_job: RenderJobTable;
  render_job_event: RenderJobEventTable;
  // ⑧ 平台规则与派生
  platform_rule: PlatformRuleTable;
  derivative: DerivativeTable;
  // ⑨ 合规与导出
  compliance_report: ComplianceReportTable;
  export_package: ExportPackageTable;
  // ⑩ 配额账本
  quota_account: QuotaAccountTable;
  quota_reservation: QuotaReservationTable;
  quota_ledger: QuotaLedgerTable;
  // ⑪ 热点
  trend: TrendTable;
  // ⑫ 自研持久队列
  job_queue: JobQueueTable;
  // ⑬ 指标聚合
  metric_snapshot: MetricSnapshotTable;
  // ⑭ 其余支撑
  idempotency_record: IdempotencyRecordTable;
  analytics_event: AnalyticsEventTable;
  ai_call_log: AiCallLogTable;
  audit_log: AuditLogTable;
  voice_catalog: VoiceCatalogTable;
  template_catalog: TemplateCatalogTable;
}

export type SchemaTableName = keyof Database;

export * from './column-types.js';
export * from './db-enums.js';
export * from './json-shapes.js';
export type {
  AppUserTable,
  StyleProfileTable,
  StyleSampleTable,
  UserSourceConfigTable,
} from './user.js';
export type { MaterialTable, WorkMaterialTable, WorkTable } from './work.js';
export type { SearchSessionTable, TopicBatchTable, TopicTable, TrendTable } from './discover.js';
export type {
  ScriptLineTable,
  ScriptRevisionTable,
  ScriptSectionTable,
  ScriptTable,
  ScriptVariantTable,
  StyleHunkTable,
} from './script.js';
export type {
  AssetLayerTable,
  RenderJobEventTable,
  RenderJobTable,
  VideoAssetLayerTable,
  VideoAssetTable,
} from './media.js';
export type { DerivativeTable, PlatformRuleTable } from './derivative.js';
export type { ComplianceReportTable, ExportPackageTable } from './compliance.js';
export type { QuotaAccountTable, QuotaLedgerTable, QuotaReservationTable } from './quota.js';
export type { JobQueueTable, MetricSnapshotTable } from './queue.js';
export type {
  AiCallLogTable,
  AnalyticsEventTable,
  AuditLogTable,
  IdempotencyRecordTable,
} from './ops.js';
export type { TemplateCatalogTable, VoiceCatalogTable } from './catalog.js';
