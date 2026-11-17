import { z } from 'zod';
import { DurationVersion, PlatformId, ScriptStatus, SectionKind } from './enums.js';
import { PrefixedId, RelativePath, UtcTimestamp } from './dto.js';

export const ScriptLineSchema = z.object({
  id: PrefixedId,
  sectionId: PrefixedId,
  ord: z.number().int().min(0),
  text: z.string(),
  editedByUser: z.boolean(),
  /** DB STORED 生成列 CHAR_LENGTH(text)；只读，不含「可编辑」提示装饰层（D-11）。 */
  charCount: z.number().int().min(0),
});
export type ScriptLine = z.infer<typeof ScriptLineSchema>;

export const ScriptSectionSchema = z.object({
  id: PrefixedId,
  kind: SectionKind,
  ord: z.number().int().min(0),
  rangeStart: z.number().int().min(0).nullable(),
  rangeEnd: z.number().int().min(0).nullable(),
  lines: z.array(ScriptLineSchema),
});
export type ScriptSection = z.infer<typeof ScriptSectionSchema>;

export const ScriptSchema = z.object({
  id: PrefixedId,
  workId: PrefixedId,
  version: z.number().int().min(1),
  status: ScriptStatus,
  confirmedAt: UtcTimestamp.nullable(),
  /** round(字数 / 4.2)，仅编辑期提示（D-10）。 */
  estimatedDuration: z.number().int().min(0).nullable(),
  /** TTS 对齐后真值，播放器时码唯一权威（D-10）。 */
  actualDuration: z.number().int().min(0).nullable(),
  sections: z.array(ScriptSectionSchema),
});
export type Script = z.infer<typeof ScriptSchema>;

/** AUTOSAVE_CONFLICT 的双版本快照（架构 §11.3）。 */
export const ScriptSnapshotSchema = z.object({
  version: z.number().int().min(1),
  sections: z.array(ScriptSectionSchema),
});
export type ScriptSnapshot = z.infer<typeof ScriptSnapshotSchema>;

export const DerivativeValidationSchema = z.object({
  field: z.string(),
  level: z.enum(['warn', 'block']),
  message: z.string(),
});
export type DerivativeValidation = z.infer<typeof DerivativeValidationSchema>;

/** 每平台一行，UNIQUE(work_id, platform_id)，改一个平台只 PATCH 一行（AC-P4）。 */
export const DerivativeSchema = z.object({
  id: PrefixedId,
  workId: PrefixedId,
  platformId: PlatformId,
  title: z.string().max(255),
  tags: z.array(z.string()),
  durationVersion: DurationVersion,
  coverLayerId: PrefixedId.nullable(),
  videoAssetId: PrefixedId.nullable(),
  /** 平台成片预览地址；mediaReady=false 时为 null。 */
  mediaUrl: RelativePath.nullable(),
  ruleVersion: z.number().int().min(0),
  /** D-07：渲染前即可 true（仅需 G2）。 */
  metadataReady: z.boolean(),
  /** G3 后才可能 true。 */
  mediaReady: z.boolean(),
  validation: z.array(DerivativeValidationSchema),
});
export type Derivative = z.infer<typeof DerivativeSchema>;
