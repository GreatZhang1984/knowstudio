/** ⑧ 平台规则与派生（架构 §4.4 793–836 行）。 */
import type { DurationVersion } from '@knowstudio/contracts';
import type { Bool, DbGenerated, Defaulted, Id, JsonColDefaulted, Nullable, UtcDateTime } from './column-types.js';
import type { Orient } from './db-enums.js';

export interface PlatformRuleTable {
  platform_id: string;
  version: number;
  name: string;
  /** '9:16' | '16:9'。 */
  ratio: string;
  max_duration: number;
  orient: Orient;
  brand_color: string;
  style_hint: string;
  /** 建议字数（超 → warn）。 */
  title_max: number;
  /** 硬上限（超 → block）[架构推断]。 */
  title_hard_max: number;
  tag_max: number;
  banned_patterns: JsonColDefaulted;
  is_current: Defaulted<Bool>;
  updated_at: Defaulted<UtcDateTime>;
  /** STORED 生成列 AS (IF(is_current,1,NULL))：每平台恰好一个当前版本。 */
  current_flag: DbGenerated<1 | null>;
}

export interface DerivativeTable {
  id: Id;
  work_id: Id;
  user_id: Id;
  platform_id: string;
  title: Defaulted<string>;
  tags: JsonColDefaulted<string[]>;
  duration_version: Defaulted<DurationVersion>;
  cover_layer_id: Nullable<Id>;
  video_asset_id: Nullable<Id>;
  rule_version: number;
  /** D-07：渲染前即可 1（metadata 派生仅需 G2）。 */
  metadata_ready: Defaulted<Bool>;
  /** G3 后才可能 1（media 派生）。 */
  media_ready: Defaulted<Bool>;
  validation: JsonColDefaulted;
  updated_at: Defaulted<UtcDateTime>;
}