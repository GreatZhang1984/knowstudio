/**
 * 列级 ENUM 中**不在 contracts 的 18 个落库枚举清单内**的三个（架构 §4.2 表只列了 18 个，
 * 但 §4.4 DDL 另有这三处列级 ENUM）。它们只服务 DB 列值域，故就近定义在 schema 层，
 * 不反向污染 contracts 的 DB_ENUMS（那份清单与架构 §4.2 表逐字对应，有单测守着）。
 */

/** style_sample.source */
export type StyleSampleSource = 'upload' | 'paste';

/** style_sample.status */
export type StyleSampleStatus = 'learning' | 'ready' | 'failed';

/** video_asset.orient / platform_rule.orient */
export type Orient = 'vertical' | 'horizontal';