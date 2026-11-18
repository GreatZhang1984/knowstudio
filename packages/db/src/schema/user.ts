/** ① 用户与风格（架构 §4.4 420–467 行）。app_user 的 DDL 属客户冻结项，类型亦逐列对齐。 */
import type {
  Bool,
  Defaulted,
  Id,
  JsonCol,
  JsonColDefaulted,
  Nullable,
  UtcDateTime,
} from './column-types.js';
import type { StyleSampleSource, StyleSampleStatus } from './db-enums.js';
import type { PlatformIdList } from './json-shapes.js';

export interface AppUserTable {
  id: Id;
  name: string;
  avatar_url: Nullable<string>;
  phone: Nullable<string>;
  email: Nullable<string>;
  /** 客户冻结：VARCHAR(255) NULL 已存在，不得改动。 */
  password_hash: Nullable<string>;
  domain_prefs: JsonColDefaulted;
  default_platforms: JsonColDefaulted<PlatformIdList>;
  plan_id: Defaulted<string>;
  theme: Defaulted<string>;
  onboarded_at: Nullable<UtcDateTime>;
  created_at: Defaulted<UtcDateTime>;
}

export interface StyleSampleTable {
  id: Id;
  user_id: Id;
  title: string;
  content: string;
  source: StyleSampleSource;
  status: Defaulted<StyleSampleStatus>;
  /** 注意：这是**普通 INT 列**，不是生成列（与 script_line.char_count 不同）。 */
  char_count: number;
  created_at: Defaulted<UtcDateTime>;
}

export type UserSourceConfigId = 'web_search' | 'obsidian';

export interface UserSourceConfigTable {
  user_id: Id;
  source_id: UserSourceConfigId;
  enabled: Defaulted<0 | 1>;
  settings: JsonCol;
  credential_ciphertext: Nullable<string>;
  credential_last4: Nullable<string>;
  tested_at: Nullable<UtcDateTime>;
  created_at: Defaulted<UtcDateTime>;
  updated_at: Defaulted<UtcDateTime>;
}

export interface StyleProfileTable {
  user_id: Id;
  catchphrases: JsonColDefaulted;
  sentence_patterns: JsonColDefaulted;
  case_preferences: JsonColDefaulted;
  tone: Nullable<string>;
  sample_count: Defaulted<number>;
  version: Defaulted<number>;
  /** SPEC §3.4 冷启动兜底。 */
  is_default: Defaulted<Bool>;
  updated_at: Defaulted<UtcDateTime>;
}
