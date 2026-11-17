/** ⑤ 文案（架构 §4.4 604–689 行）。 */
import type { HunkStatus, RevisionReason, ScriptStatus, SectionKind } from '@knowstudio/contracts';
import type {
  Bool,
  DbGenerated,
  Defaulted,
  Id,
  JsonCol,
  Nullable,
  UtcDateTime,
} from './column-types.js';
import type { ScriptDiffEntry } from './json-shapes.js';

export interface ScriptTable {
  id: Id;
  work_id: Id;
  user_id: Id;
  version: Defaulted<number>;
  status: Defaulted<ScriptStatus>;
  confirmed_at: Nullable<UtcDateTime>;
  /** round(字数/4.2)，仅编辑期提示。 */
  estimated_duration: Nullable<number>;
  /** TTS 对齐后真值，唯一权威（D-10）。 */
  actual_duration: Nullable<number>;
  /** 大改率基线（SPEC §11）。 */
  generated_text: Nullable<string>;
  created_at: Defaulted<UtcDateTime>;
  updated_at: Defaulted<UtcDateTime>;
}

export interface ScriptSectionTable {
  id: Id;
  script_id: Id;
  kind: SectionKind;
  ord: number;
  /** 原 int4range [start,end) 拆两列；CHECK ck_section_range: start < end。 */
  range_start: Nullable<number>;
  range_end: Nullable<number>;
}

export interface ScriptLineTable {
  id: Id;
  section_id: Id;
  ord: number;
  /** TEXT 是类型关键字，DDL 中反引号包裹。 */
  text: string;
  edited_by_user: Defaulted<Bool>;
  /** STORED 生成列 AS (CHAR_LENGTH(`text`))：D-11 字数不含提示装饰层。 */
  char_count: DbGenerated<number>;
}

export interface ScriptRevisionTable {
  id: Id;
  script_id: Id;
  version: number;
  diff: JsonCol<ScriptDiffEntry[]>;
  reason: RevisionReason;
  /** 全量快照，支撑 ≥20 步撤销与冲突双版本。 */
  snapshot: JsonCol;
  created_at: Defaulted<UtcDateTime>;
}

export interface StyleHunkTable {
  id: Id;
  script_id: Id;
  /** FK ON DELETE SET NULL。 */
  line_id: Nullable<Id>;
  ord: number;
  original: string;
  rewritten: string;
  status: Defaulted<HunkStatus>;
  resolved_at: Nullable<UtcDateTime>;
}

export interface ScriptVariantTable {
  id: Id;
  script_id: Id;
  platform_id: string;
  content: JsonCol;
  duration: Nullable<number>;
  derived_at: Defaulted<UtcDateTime>;
}