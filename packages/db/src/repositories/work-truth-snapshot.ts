/**
 * 闸门真相快照加载器（架构 §5.3「读 WorkTruthSnapshot 单次聚合查询」/ §8.4 指纹输入）。
 *
 * ## 职责边界
 * 本加载器**只聚合真相**，不做任何闸门判定：布尔值一律由 apps/api 调 domain.deriveGates
 * 从本快照重算（D-04 对策）。入参 work 行已通过 OwnershipGuard，故子查询仍逐条带
 * work_id + user_id 谓词做结构性隔离（架构 §13），不依赖调用方自觉。
 *
 * ## 真实聚合源（36 表内确有列者）
 * - G1：work.selected_topic_id
 * - G2：script.status / confirmed_at / version
 * - G3：最新 hd video_asset.status / stale / script_version
 * - G4：最新 compliance_report.blocking_count / fingerprint
 * - 指纹输入：work_material⋈material（授权态）、derivative（规则版本/标题/标签）、
 *   template_catalog（字体，经 hd asset.template_id 引用）、asset_layer(kind=bgm)
 *
 * ## [待确认] 缺口（架构 §8.4 列了输入，但 T-03 的 36 表未物化对应列）
 * 以下指纹输入在 v1 schema 无权威数据源，本加载器据实取中性值并在此披露，
 * **绝不发明闸门放行**：G4 需 compliance_report 存在且指纹匹配才可能 true，
 * v1 演示无合规报告 → G4 恒 false（deriveGates 短路），故这些值不影响任何门。
 *  1. script.contentHash：script 表无 content_hash 列。这里对**真实** script_line 正文
 *     （按 section.ord, line.ord 排序，'\n' 连接）取 sha256。规范化形式待合规引擎
 *     （T-54/T-55）落地时统一，否则两侧指纹会不一致。
 *  2. materials[].licenseEvidenceVersion：material.license_evidence JSON 未声明 version 键。
 *     有数值 version 则读之，否则 0（v1 凭证未版本化）。
 *  3. lexiconVersion：敏感词库属 P1 admin（架构 §3.1），v1 无词库表 → 0（未版本化）。
 *  4. bgm.evidenceExpiresAt：bgm 层 meta 未声明凭证过期键；有则读，否则 null。
 * 这些缺口已在交付报告 §[待确认] 列出，需产品/架构裁决数据源，不在本 Task 自行发明。
 */
import { createHash } from 'node:crypto';
import type { Kysely } from 'kysely';
import { WorkTruthSnapshotSchema, type WorkTruthSnapshot } from '@knowstudio/contracts';
import type { Database } from '../schema/index.js';
import type { WorkRow } from './work-repository.js';

export class WorkSnapshotTimestampInvalidError extends Error {
  readonly code = 'WORK_SNAPSHOT_TIMESTAMP_INVALID';
  constructor(readonly raw: string) {
    super('快照时间列不是 DATETIME(3) UTC 字面量，拒绝下发歧义时间');
    this.name = 'WorkSnapshotTimestampInvalidError';
  }
}

const DB_UTC_LITERAL = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/;
function toRfc3339(literal: string): string {
  if (!DB_UTC_LITERAL.test(literal)) throw new WorkSnapshotTimestampInvalidError(literal);
  return `${literal.replace(' ', 'T')}Z`;
}

/** license_evidence / asset_layer.meta 是 JSON 列，运行时已解析；只读架构明写或可能存在的键。 */
function evidenceVersion(evidence: unknown): number {
  const v = (evidence as { version?: unknown } | null)?.version;
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0;
}

/** 端口形状（与 apps/api/src/works/work-ports.ts 的 WorkTruthSnapshotLoader 结构一致）。 */
export interface WorkTruthSnapshotLoader {
  load(work: WorkRow): Promise<WorkTruthSnapshot>;
}

export function createWorkTruthSnapshotLoader(db: Kysely<Database>): WorkTruthSnapshotLoader {
  return {
    async load(work: WorkRow): Promise<WorkTruthSnapshot> {
      const workId = work.id;
      const userId = work.user_id;

      // ── G2 真相：当前文案（取最高 version；script_revision 存历史，不在此读）──
      const scriptRow = await db
        .selectFrom('script')
        .select(['id', 'version', 'status', 'confirmed_at'])
        .where('work_id', '=', workId)
        .where('user_id', '=', userId)
        .orderBy('version', 'desc')
        .limit(1)
        .executeTakeFirst();

      // ── G3 真相：最新 hd 母版 ──
      const hdAsset = await db
        .selectFrom('video_asset')
        .select(['id', 'status', 'stale', 'script_version', 'template_id'])
        .where('work_id', '=', workId)
        .where('user_id', '=', userId)
        .where('quality', '=', 'hd')
        .orderBy('created_at', 'desc')
        .limit(1)
        .executeTakeFirst();

      // ── G4 真相：最新合规报告 ──
      const compliance = await db
        .selectFrom('compliance_report')
        .select(['blocking_count', 'fingerprint'])
        .where('work_id', '=', workId)
        .where('user_id', '=', userId)
        .orderBy('checked_at', 'desc')
        .limit(1)
        .executeTakeFirst();

      // ── 指纹输入：引用素材及授权态（work_material 带 user_id 谓词；material 可为全局公共库）──
      const materialRows = await db
        .selectFrom('work_material')
        .innerJoin('material', 'material.id', 'work_material.material_id')
        .select(['material.id', 'material.license', 'material.license_evidence'])
        .where('work_material.work_id', '=', workId)
        .where('work_material.user_id', '=', userId)
        .execute();

      // ── 指纹输入：派生与规则版本 ──
      const derivativeRows = await db
        .selectFrom('derivative')
        .select(['platform_id', 'rule_version', 'title', 'tags'])
        .where('work_id', '=', workId)
        .where('user_id', '=', userId)
        .execute();

      // ── 指纹输入：模板字体（经 hd asset.template_id 引用 template_catalog）──
      const templateRow =
        hdAsset?.template_id != null
          ? await db
              .selectFrom('template_catalog')
              .select(['id', 'version', 'font_family'])
              .where('id', '=', hdAsset.template_id)
              .executeTakeFirst()
          : undefined;

      // ── 指纹输入：BGM 授权（最新 bgm 层 meta.trackId + 凭证过期）──
      const bgmLayer = await db
        .selectFrom('asset_layer')
        .select(['meta'])
        .where('work_id', '=', workId)
        .where('user_id', '=', userId)
        .where('kind', '=', 'bgm')
        .orderBy('created_at', 'desc')
        .limit(1)
        .executeTakeFirst();

      // ── script.contentHash：对真实正文取 sha256（规范化形式 [待确认]，见文件头）──
      let script: WorkTruthSnapshot['script'] = null;
      if (scriptRow !== undefined) {
        const lines = await db
          .selectFrom('script_line')
          .innerJoin('script_section', 'script_section.id', 'script_line.section_id')
          .select(['script_line.text'])
          .where('script_section.script_id', '=', scriptRow.id)
          .orderBy('script_section.ord', 'asc')
          .orderBy('script_line.ord', 'asc')
          .execute();
        const contentHash = createHash('sha256')
          .update(lines.map((l) => l.text).join('\n'), 'utf8')
          .digest('hex');
        script = {
          id: scriptRow.id,
          version: scriptRow.version,
          status: scriptRow.status,
          confirmedAt: scriptRow.confirmed_at === null ? null : toRfc3339(scriptRow.confirmed_at),
          contentHash,
        };
      }

      const bgmMeta = bgmLayer?.meta as { trackId?: unknown; evidenceExpiresAt?: unknown } | undefined;
      const bgmTrackId = typeof bgmMeta?.trackId === 'string' ? bgmMeta.trackId : null;
      const bgmExpiresRaw = bgmMeta?.evidenceExpiresAt;
      const bgm: WorkTruthSnapshot['bgm'] =
        bgmTrackId === null
          ? null
          : {
              trackId: bgmTrackId,
              evidenceExpiresAt:
                typeof bgmExpiresRaw === 'string' && bgmExpiresRaw.length > 0
                  ? toRfc3339(bgmExpiresRaw)
                  : null,
            };

      // 据实构造后交契约 schema 兜底校验（platformId/license/status 值域、fingerprint 长度、
      // 时间格式）。任何漂移在此抛错，而不是把非法快照交给 deriveGates。
      return WorkTruthSnapshotSchema.parse({
        workId,
        selectedTopicId: work.selected_topic_id,
        script,
        latestHdAsset:
          hdAsset === undefined
            ? null
            : {
                id: hdAsset.id,
                status: hdAsset.status,
                stale: hdAsset.stale === 1,
                scriptVersion: hdAsset.script_version,
              },
        latestCompliance:
          compliance === undefined
            ? null
            : { blockingCount: compliance.blocking_count, fingerprint: compliance.fingerprint },
        materials: materialRows.map((m) => ({
          materialId: m.id,
          license: m.license,
          licenseEvidenceVersion: evidenceVersion(m.license_evidence),
        })),
        derivatives: derivativeRows.map((d) => ({
          platformId: d.platform_id,
          ruleVersion: d.rule_version,
          title: d.title,
          tags: d.tags,
        })),
        template:
          templateRow === undefined
            ? null
            : {
                templateId: templateRow.id,
                version: templateRow.version,
                fontFamily: templateRow.font_family,
              },
        bgm,
        // [待确认] v1 无版本化敏感词库表（P1 admin 后置）；G4 无合规报告时短路，此值不影响门。
        lexiconVersion: 0,
      });
    },
  };
}