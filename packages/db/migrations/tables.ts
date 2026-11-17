/**
 * 36 张表硬不变量（客户 2026-11-13 拍板）。
 *
 * 来源：架构 §4.4 的 36 条 CREATE TABLE，以及架构 §16「24 实体 + 12 支撑 = 36」的清点。
 * 本清单是**断言基准**，不是第二份真相：runner 会把它与 0001_baseline.sql 里实际解析出的
 * 表名集合做双向比对，任何增删都会 fail-fast。
 *
 * 两条不可触碰的约束：
 *   1) 恰好 36 张，不得出现第 37 张。会话/refresh token 存 Redis，**不建会话表**。
 *      因此 Kysely 内置 Migrator 被禁用（它会建 kysely_migration + kysely_migration_lock）。
 *   2) app_user 的 DDL 不得修改（架构 420–438 行）。
 */

/** 架构 §4.4 的建表顺序（即 FK 依赖顺序）。 */
export const TABLE_ORDER = [
  // ① 用户与风格
  'app_user',
  'style_sample',
  'style_profile',
  // ② Work 核心上下文
  'work',
  // ③ 素材与引用
  'material',
  'work_material',
  // ④ 搜索与选题
  'search_session',
  'topic_batch',
  'topic',
  // ⑤ 文案
  'script',
  'script_section',
  'script_line',
  'script_revision',
  'style_hunk',
  'script_variant',
  // ⑥ 分层资产与视频
  'asset_layer',
  'video_asset',
  'video_asset_layer',
  // ⑦ 渲染任务
  'render_job',
  'render_job_event',
  // ⑧ 平台规则与派生
  'platform_rule',
  'derivative',
  // ⑨ 合规与导出
  'compliance_report',
  'export_package',
  // ⑩ 配额账本
  'quota_account',
  'quota_reservation',
  'quota_ledger',
  // ⑪ 热点
  'trend',
  // ⑫ 自研持久队列
  'job_queue',
  // ⑬ 指标聚合
  'metric_snapshot',
  // ⑭ 其余支撑
  'idempotency_record',
  'analytics_event',
  'ai_call_log',
  'audit_log',
  'voice_catalog',
  'template_catalog',
] as const;

export type TableName = (typeof TABLE_ORDER)[number];

/** 架构 §16 明列的 12 张支撑表。 */
export const SUPPORT_TABLES = [
  'asset_layer',
  'video_asset_layer',
  'render_job_event',
  'quota_reservation',
  'idempotency_record',
  'analytics_event',
  'ai_call_log',
  'audit_log',
  'voice_catalog',
  'template_catalog',
  'job_queue',
  'metric_snapshot',
] as const;

export const ENTITY_TABLE_COUNT = 24;
export const SUPPORT_TABLE_COUNT = 12;
export const TOTAL_TABLE_COUNT = 36;

/** 24 实体 = 36 全表 − 12 支撑（由集合运算得出，避免手抄第二份名单）。 */
export const ENTITY_TABLES: readonly TableName[] = TABLE_ORDER.filter(
  (t) => !(SUPPORT_TABLES as readonly string[]).includes(t),
);

/**
 * 明确禁止出现的表名。
 * - kysely_migration / kysely_migration_lock：内置 Migrator 的账本表，会把 36 变成 38
 * - session / user_session / refresh_token：会话存 Redis（客户拍板），落库即破坏 36 不变量
 */
export const FORBIDDEN_TABLES = [
  'kysely_migration',
  'kysely_migration_lock',
  'session',
  'sessions',
  'user_session',
  'user_sessions',
  'refresh_token',
  'refresh_tokens',
] as const;