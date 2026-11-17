/**
 * 种子应用器（SPEC §4.3）。
 *
 * 口径：3 作品 / 10 素材 / 12 角度 / 文案 10 行 212 字 / 配额 total 60 used 22 left 38，
 *       另有 音色 4 / 模板 4 / 平台 4 / 素材库 8 / 初始收藏 {k1,h1} / 空白角度 3。
 *
 * 三条纪律：
 *   1) **先校验后写库**：任何计数不符立刻抛 SeedInvariantError，绝不把错数据写进去。
 *   2) **幂等**：种子用户已存在即整体跳过，只回报实测计数（重复执行不产生第二份数据）。
 *   3) **不发明需求**：SPEC 未给出的内容（w2/w3 的选题与文案正文、音色真实商用凭证、
 *      模板 6 页型中未命名的 2 个、平台标题硬上限）一律不编造，留空或在报告里列 [待确认]。
 *
 * ID 生成：架构 §4.3.2 约定「前缀_ + 26 位 ULID」。这里用**确定性** ULID
 * （固定时间戳 + sha256(key) 派生的随机段），使 fixture 可被测试稳定引用。
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { Database } from '../src/schema/index.js';
import { toJsonParam } from '../src/schema/column-types.js';
import type { DbHandle } from '../src/client.js';
import type { GatesCache, LicenseEvidence, Saturation } from '../src/schema/json-shapes.js';
import type {
  JobStatus,
  LicenseState,
  MaterialType,
  TrendLifecycle,
  WorkStep,
} from '@knowstudio/contracts';
import type { Orient } from '../src/schema/db-enums.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** fixtures/ 在仓库根（架构 §3.1 布局）。 */
export const DEFAULT_SEED_PATH = path.resolve(HERE, '../../../fixtures/seed.json');

/** SPEC §4.3 明写的计数，作为 fail-fast 基准。 */
export const SEED_EXPECTATIONS = {
  works: 3,
  materials: 10,
  libraryMaterials: 8,
  collected: 2,
  topics: 12,
  scriptSections: 3,
  scriptLines: 10,
  scriptChars: 212,
  estimatedDuration: 50,
  sectionLineCounts: [2, 6, 2],
  quotaTotal: 60,
  quotaUsed: 22,
  quotaReserved: 0,
  quotaLeft: 38,
  hdPointsPerRender: 2,
  voices: 4,
  templates: 4,
  platformRules: 4,
  trends: 3,
  blankAngles: 3,
} as const;

export class SeedInvariantError extends Error {
  readonly code = 'SEED_INVARIANT_VIOLATION';
  constructor(readonly problems: readonly string[]) {
    super(`种子数据不符合 SPEC §4.3：\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'SeedInvariantError';
  }
}

// ── fixtures 形状 ────────────────────────────────────────────────────────────

export interface SeedWork {
  key: string;
  title: string;
  keyword: string | null;
  step: WorkStep;
  selectedTopicKey: string | null;
  scriptConfirmed: boolean;
  minutesAgo: number;
  exported?: boolean;
  gates: GatesCache;
}

export interface SeedMaterial {
  key: string;
  type: MaterialType;
  title: string;
  source: string;
  sourceColor: string | null;
  license: LicenseState;
  licenseEvidence: LicenseEvidence | null;
  tags: string[];
  meta: Record<string, unknown>;
  bodyText: string | null;
  /** true = 已导入素材库（user_id 归属种子用户）；false = 全局公共库（user_id NULL）。 */
  library: boolean;
}

export interface SeedTopic {
  key: string;
  hook: string;
  angle: string;
  blankPoint: string;
  basis: string[];
}

export interface SeedData {
  meta: { source: string; task: string; notes: string[] };
  user: {
    key: string;
    name: string;
    email: string | null;
    phone: string | null;
    planId: string;
    theme: string;
    domainPrefs: string[];
    defaultPlatforms: string[];
  };
  works: SeedWork[];
  materials: SeedMaterial[];
  collected: string[];
  topicBatch: {
    key: string;
    workKey: string;
    batchIndex: number;
    basedOnMaterialKeys: string[];
    effectiveCount: number;
    regenAttempts: number;
  };
  topics: SeedTopic[];
  script: {
    key: string;
    workKey: string;
    estimatedDuration: number;
    sections: {
      kind: 'hook3s' | 'body' | 'outro';
      rangeStart: number;
      rangeEnd: number;
      lines: string[];
    }[];
  };
  search: {
    key: string;
    workKey: string;
    keyword: string;
    domain: string;
    status: JobStatus;
    saturation: Saturation;
    blankAngles: string[];
  };
  quota: {
    planId: string;
    total: number;
    used: number;
    reserved: number;
    hdPointsPerRender: number;
    commitWorkKeys: string[];
  };
  styleProfile: {
    catchphrases: string[];
    sentencePatterns: string[];
    casePreferences: string[];
    tone: string | null;
    sampleCount: number;
    version: number;
    isDefault: 0 | 1;
  };
  platformRules: {
    platformId: string;
    version: number;
    name: string;
    ratio: string;
    maxDuration: number;
    orient: Orient;
    brandColor: string;
    styleHint: string;
    titleMax: number;
    titleHardMax: number;
    tagMax: number;
    bannedPatterns: string[];
    isCurrent: 0 | 1;
  }[];
  voices: {
    key: string;
    id: string;
    provider: string;
    name: string;
    gender: string;
    timbre: string;
    ord: number;
  }[];
  templates: {
    key: string;
    id: string;
    name: string;
    version: number;
    palette: Record<string, string>;
    fontFamily: string;
    ord: number;
  }[];
  pageTypes: string[];
  trends: {
    key: string;
    materialKey: string;
    domain: string;
    name: string;
    lifecycle: TrendLifecycle;
    windowHours: number;
    source: string;
    heat: number | null;
  }[];
}

export function loadSeedData(file: string = DEFAULT_SEED_PATH): SeedData {
  return JSON.parse(readFileSync(file, 'utf8')) as SeedData;
}

// ── 确定性 ID 与时间 ─────────────────────────────────────────────────────────

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** 固定种子时间戳：2026-11-13T00:00:00Z（客户拍板日），保证 ID 可复现。 */
const SEED_EPOCH_MS = Date.UTC(2026, 10, 13, 0, 0, 0, 0);

function encodeTime(ms: number): string {
  let out = '';
  let v = ms;
  for (let i = 0; i < 10; i += 1) {
    out = (CROCKFORD[v % 32] as string) + out;
    v = Math.floor(v / 32);
  }
  return out;
}

/** 前缀_ + 26 位 ULID（10 时间 + 16 随机），随机段由 sha256(key) 确定性派生。 */
export function seedId(prefix: string, key: string): string {
  const digest = createHash('sha256').update(`knowstudio-seed:${key}`).digest();
  let rand = '';
  for (let i = 0; i < 16; i += 1) {
    rand += CROCKFORD[(digest[i] as number) % 32];
  }
  return `${prefix}_${encodeTime(SEED_EPOCH_MS)}${rand}`;
}

/** DATETIME(3) 的 UTC 字面量。 */
export function utcLiteral(d: Date): string {
  return d.toISOString().replace('T', ' ').replace('Z', '');
}

/** hook 指纹：CHAR(64) = sha256 十六进制。 */
function hookFingerprint(hook: string): string {
  return createHash('sha256').update(hook, 'utf8').digest('hex');
}

// ── 校验 ─────────────────────────────────────────────────────────────────────

export function validateSeedData(data: SeedData): void {
  const p: string[] = [];
  const e = SEED_EXPECTATIONS;
  const check = (actual: number, expected: number, label: string): void => {
    if (actual !== expected) p.push(`${label} 为 ${actual}，SPEC 要求 ${expected}`);
  };

  check(data.works.length, e.works, '作品数');
  check(data.materials.length, e.materials, '素材数');
  check(data.materials.filter((m) => m.library).length, e.libraryMaterials, '素材库条目数');
  check(data.collected.length, e.collected, '初始收藏数');
  check(data.topics.length, e.topics, '选题数');
  check(data.script.sections.length, e.scriptSections, '文案段数');
  check(data.voices.length, e.voices, '音色数');
  check(data.templates.length, e.templates, '模板数');
  check(data.platformRules.length, e.platformRules, '平台规则数');
  check(data.trends.length, e.trends, '热点数');
  check(data.search.blankAngles.length, e.blankAngles, '空白角度数');

  const lines = data.script.sections.flatMap((s) => s.lines);
  check(lines.length, e.scriptLines, '文案行数');
  const chars = lines.reduce((n, l) => n + [...l].length, 0);
  check(chars, e.scriptChars, '文案字数');
  data.script.sections.forEach((s, i) => {
    check(s.lines.length, e.sectionLineCounts[i] as number, `第 ${i + 1} 段行数`);
  });
  check(data.script.estimatedDuration, e.estimatedDuration, '预估时长');
  check(Math.round(chars / 4.2), e.estimatedDuration, 'round(字数/4.2)');

  check(data.quota.total, e.quotaTotal, '配额 total');
  check(data.quota.used, e.quotaUsed, '配额 used');
  check(data.quota.reserved, e.quotaReserved, '配额 reserved');
  check(data.quota.total - data.quota.used - data.quota.reserved, e.quotaLeft, '配额 left');
  check(data.quota.hdPointsPerRender, e.hdPointsPerRender, '高清单价');
  check(
    data.quota.commitWorkKeys.length * data.quota.hdPointsPerRender,
    e.quotaUsed,
    'commit 点数合计',
  );

  // 引用完整性：所有 key 必须能解析，否则落库即产生悬空引用。
  const materialKeys = new Set(data.materials.map((m) => m.key));
  const topicKeys = new Set(data.topics.map((t) => t.key));
  const workKeys = new Set(data.works.map((w) => w.key));
  for (const k of data.collected) if (!materialKeys.has(k)) p.push(`收藏引用了不存在的素材 ${k}`);
  for (const t of data.topics) {
    if (t.basis.length < 1) p.push(`选题 ${t.key} 的 basis 为空（违反 ck_topic_basis）`);
    for (const k of t.basis)
      if (!materialKeys.has(k)) p.push(`选题 ${t.key} 引用了不存在的素材 ${k}`);
  }
  for (const w of data.works) {
    if (w.selectedTopicKey !== null && !topicKeys.has(w.selectedTopicKey)) {
      p.push(`作品 ${w.key} 选中了不存在的选题 ${w.selectedTopicKey}`);
    }
  }
  for (const k of data.quota.commitWorkKeys)
    if (!workKeys.has(k)) p.push(`账本引用了不存在的作品 ${k}`);
  for (const k of data.topicBatch.basedOnMaterialKeys) {
    if (!materialKeys.has(k)) p.push(`选题批引用了不存在的素材 ${k}`);
  }
  for (const t of data.trends)
    if (!materialKeys.has(t.materialKey)) p.push(`热点引用了不存在的素材 ${t.materialKey}`);

  if (p.length > 0) throw new SeedInvariantError(p);
}

// ── 实测计数 ─────────────────────────────────────────────────────────────────

export interface SeedCounts {
  works: number;
  materials: number;
  libraryMaterials: number;
  workMaterials: number;
  topics: number;
  topicBatches: number;
  scripts: number;
  scriptSections: number;
  scriptLines: number;
  scriptChars: number;
  scriptRevisions: number;
  searchSessions: number;
  quotaTotal: number;
  quotaUsed: number;
  quotaReserved: number;
  quotaLeft: number;
  ledgerRows: number;
  ledgerCommitPoints: number;
  platformRules: number;
  voices: number;
  templates: number;
  trends: number;
  styleProfiles: number;
}

/** 全部走 SELECT 实测，不拿插入时的内存数字冒充结果。 */
export async function measureSeedCounts(db: Kysely<Database>, userId: string): Promise<SeedCounts> {
  const seedWorkIds = sql.join(loadSeedData().works.map((work) => sql`${seedId('w', work.key)}`));
  const one = async (q: ReturnType<typeof sql<{ n: number }>>): Promise<number> => {
    const { rows } = await q.execute(db);
    return Number(rows[0]?.n ?? 0);
  };
  const works = await one(
    sql<{ n: number }>`SELECT COUNT(*) AS n FROM work WHERE id IN (${seedWorkIds})`,
  );
  const materials = await one(sql<{ n: number }>`SELECT COUNT(*) AS n FROM material`);
  const libraryMaterials = await one(
    sql<{ n: number }>`SELECT COUNT(*) AS n FROM material WHERE user_id = ${userId}`,
  );
  const workMaterials = await one(
    sql<{ n: number }>`SELECT COUNT(*) AS n FROM work_material WHERE work_id IN (${seedWorkIds})`,
  );
  const topics = await one(
    sql<{ n: number }>`SELECT COUNT(*) AS n FROM topic WHERE work_id IN (${seedWorkIds})`,
  );
  const topicBatches = await one(
    sql<{ n: number }>`SELECT COUNT(*) AS n FROM topic_batch WHERE work_id IN (${seedWorkIds})`,
  );
  const scripts = await one(
    sql<{ n: number }>`SELECT COUNT(*) AS n FROM script WHERE work_id IN (${seedWorkIds})`,
  );
  const scriptSections = await one(
    sql<{
      n: number;
    }>`SELECT COUNT(*) AS n FROM script_section WHERE script_id IN (SELECT id FROM script WHERE work_id IN (${seedWorkIds}))`,
  );
  const scriptLines = await one(
    sql<{
      n: number;
    }>`SELECT COUNT(*) AS n FROM script_line WHERE section_id IN (SELECT ss.id FROM script_section ss INNER JOIN script s ON s.id = ss.script_id WHERE s.work_id IN (${seedWorkIds}))`,
  );
  const scriptChars = await one(
    sql<{
      n: number;
    }>`SELECT COALESCE(SUM(char_count), 0) AS n FROM script_line WHERE section_id IN (SELECT ss.id FROM script_section ss INNER JOIN script s ON s.id = ss.script_id WHERE s.work_id IN (${seedWorkIds}))`,
  );
  const scriptRevisions = await one(
    sql<{
      n: number;
    }>`SELECT COUNT(*) AS n FROM script_revision WHERE script_id IN (SELECT id FROM script WHERE work_id IN (${seedWorkIds}))`,
  );
  const searchSessions = await one(
    sql<{ n: number }>`SELECT COUNT(*) AS n FROM search_session WHERE work_id IN (${seedWorkIds})`,
  );
  const ledgerRows = await one(sql<{ n: number }>`SELECT COUNT(*) AS n FROM quota_ledger`);
  const ledgerCommitPoints = await one(
    sql<{
      n: number;
    }>`SELECT COALESCE(SUM(points), 0) AS n FROM quota_ledger WHERE user_id = ${userId} AND action = 'commit'`,
  );
  const platformRules = await one(sql<{ n: number }>`SELECT COUNT(*) AS n FROM platform_rule`);
  const voices = await one(sql<{ n: number }>`SELECT COUNT(*) AS n FROM voice_catalog`);
  const templates = await one(sql<{ n: number }>`SELECT COUNT(*) AS n FROM template_catalog`);
  const trends = await one(sql<{ n: number }>`SELECT COUNT(*) AS n FROM trend`);
  const styleProfiles = await one(sql<{ n: number }>`SELECT COUNT(*) AS n FROM style_profile`);

  const { rows: quotaRows } = await sql<{ total: number; used: number; reserved: number }>`
    SELECT total, used, reserved FROM quota_account WHERE user_id = ${userId}
  `.execute(db);
  const q = quotaRows[0];
  const total = Number(q?.total ?? 0);
  const used = Number(q?.used ?? 0);
  const reserved = Number(q?.reserved ?? 0);

  return {
    works,
    materials,
    libraryMaterials,
    workMaterials,
    topics,
    topicBatches,
    scripts,
    scriptSections,
    scriptLines,
    scriptChars,
    scriptRevisions,
    searchSessions,
    quotaTotal: total,
    quotaUsed: used,
    quotaReserved: reserved,
    quotaLeft: total - used - reserved,
    ledgerRows,
    ledgerCommitPoints,
    platformRules,
    voices,
    templates,
    trends,
    styleProfiles,
  };
}

export interface SeedResult {
  readonly applied: boolean;
  readonly userId: string;
  readonly counts: SeedCounts;
}

export interface ApplySeedOptions {
  readonly handle: DbHandle;
  readonly seedPath?: string;
  /** 种子执行时刻（默认 new Date()）；注入可让测试得到确定时间。 */
  readonly now?: Date;
}

/** 应用种子。已存在则跳过（幂等），并回报 SELECT 实测计数。 */
export async function applySeed(options: ApplySeedOptions): Promise<SeedResult> {
  const { handle } = options;
  const db = handle.db;
  const data = loadSeedData(options.seedPath);
  validateSeedData(data);

  const now = options.now ?? new Date();
  const userId = seedId('u', data.user.key);

  const existing = await db
    .selectFrom('app_user')
    .select('id')
    .where('id', '=', userId)
    .executeTakeFirst();
  if (existing !== undefined) {
    return { applied: false, userId, counts: await measureSeedCounts(db, userId) };
  }

  const at = (minutesAgo: number): string =>
    utcLiteral(new Date(now.getTime() - minutesAgo * 60_000));

  // ── ① 用户与风格 ──
  await db
    .insertInto('app_user')
    .values({
      id: userId,
      name: data.user.name,
      avatar_url: null,
      phone: data.user.phone,
      email: data.user.email,
      password_hash: null,
      domain_prefs: toJsonParam(data.user.domainPrefs),
      default_platforms: toJsonParam(data.user.defaultPlatforms),
      plan_id: data.user.planId,
      theme: data.user.theme,
      onboarded_at: null,
    })
    .execute();

  await db
    .insertInto('style_profile')
    .values({
      user_id: userId,
      catchphrases: toJsonParam(data.styleProfile.catchphrases),
      sentence_patterns: toJsonParam(data.styleProfile.sentencePatterns),
      case_preferences: toJsonParam(data.styleProfile.casePreferences),
      tone: data.styleProfile.tone,
      sample_count: data.styleProfile.sampleCount,
      version: data.styleProfile.version,
      is_default: data.styleProfile.isDefault,
    })
    .execute();

  // ── ② 作品（selected_topic_id 先留空，选题落库后回填；该列故意无 FK）──
  const workIdOf = new Map<string, string>();
  for (const w of data.works) {
    const id = seedId('w', w.key);
    workIdOf.set(w.key, id);
    await db
      .insertInto('work')
      .values({
        id,
        user_id: userId,
        title: w.title,
        keyword: w.keyword,
        phase: phaseOfStep(w.step),
        step: w.step,
        selected_topic_id: null,
        script_confirmed_at: null,
        active_render_job_id: null,
        gates: toJsonParam(w.gates),
        gates_fingerprint: null,
        exported_at: w.exported === true ? at(w.minutesAgo) : null,
        deleted_at: null,
        created_at: at(w.minutesAgo),
        updated_at: at(w.minutesAgo),
      })
      .execute();
  }

  // ── ③ 素材（library=true 归属用户，false 为全局公共库 user_id NULL）──
  const materialIdOf = new Map<string, string>();
  for (const m of data.materials) {
    const id = seedId('mat', m.key);
    materialIdOf.set(m.key, id);
    await db
      .insertInto('material')
      .values({
        id,
        user_id: m.library ? userId : null,
        type: m.type,
        title: m.title,
        source: m.source,
        source_url: null,
        source_color: m.sourceColor,
        meta: toJsonParam(m.meta),
        body_text: m.bodyText,
        storage_key: null,
        license: m.license,
        license_evidence: m.licenseEvidence === null ? null : toJsonParam(m.licenseEvidence),
        tags: toJsonParam(m.tags),
        fetched_at: m.type === 'knowledge' ? null : at(60),
        deleted_at: null,
      })
      .execute();
  }

  // ── 初始收藏 {k1,h1} → work_material（w1 上下文）──
  const collectWorkId = workIdOf.get('w1') as string;
  for (const key of data.collected) {
    await db
      .insertInto('work_material')
      .values({
        work_id: collectWorkId,
        material_id: materialIdOf.get(key) as string,
        user_id: userId,
        used_in: toJsonParam([]),
      })
      .execute();
  }

  // ── ④ 搜索会话（饱和度 72% + 空白角度 3）──
  await db
    .insertInto('search_session')
    .values({
      id: seedId('ss', data.search.key),
      work_id: workIdOf.get(data.search.workKey) as string,
      user_id: userId,
      keyword: data.search.keyword,
      domain: data.search.domain,
      status: data.search.status,
      saturation: toJsonParam(data.search.saturation),
      blank_angles: toJsonParam(data.search.blankAngles),
      material_ids: toJsonParam(data.materials.map((m) => materialIdOf.get(m.key) as string)),
      partial_errors: toJsonParam([]),
      duration_ms: null,
      cache_hit: 0,
    })
    .execute();

  // ── 选题批 + 12 角度 ──
  const batchId = seedId('tb', data.topicBatch.key);
  await db
    .insertInto('topic_batch')
    .values({
      id: batchId,
      work_id: workIdOf.get(data.topicBatch.workKey) as string,
      user_id: userId,
      batch_index: data.topicBatch.batchIndex,
      based_on_material_ids: toJsonParam(
        data.topicBatch.basedOnMaterialKeys.map((k) => materialIdOf.get(k) as string),
      ),
      hook_fingerprints: toJsonParam(data.topics.map((t) => hookFingerprint(t.hook))),
      min_pairwise_cosine: null,
      regen_attempts: data.topicBatch.regenAttempts,
      effective_count: data.topicBatch.effectiveCount,
    })
    .execute();

  const topicIdOf = new Map<string, string>();
  for (let i = 0; i < data.topics.length; i += 1) {
    const t = data.topics[i] as SeedTopic;
    const id = seedId('t', t.key);
    topicIdOf.set(t.key, id);
    await db
      .insertInto('topic')
      .values({
        id,
        batch_id: batchId,
        work_id: workIdOf.get(data.topicBatch.workKey) as string,
        hook: t.hook,
        angle: t.angle,
        blank_point: t.blankPoint,
        basis_material_ids: toJsonParam(t.basis.map((k) => materialIdOf.get(k) as string)),
        diversity_score: null,
        // SPEC 未给向量；EmbeddingPort 未接入，故留 NULL（ck_topic_emb_dim 允许 NULL）。
        embedding: null,
        hook_fingerprint: hookFingerprint(t.hook),
        ord: i + 1,
      })
      .execute();
  }

  // 回填 G1 真相（w1 选中 t03，SPEC §5 响应示例）
  for (const w of data.works) {
    if (w.selectedTopicKey === null) continue;
    await db
      .updateTable('work')
      .set({ selected_topic_id: topicIdOf.get(w.selectedTopicKey) as string })
      .where('id', '=', workIdOf.get(w.key) as string)
      .execute();
  }

  // ── ⑤ 文案：3 段 / 10 行 / 212 字 ──
  const scriptId = seedId('sc', data.script.key);
  const allLines = data.script.sections.flatMap((s) => s.lines);
  await db
    .insertInto('script')
    .values({
      id: scriptId,
      work_id: workIdOf.get(data.script.workKey) as string,
      user_id: userId,
      version: 1,
      status: 'draft',
      confirmed_at: null,
      estimated_duration: data.script.estimatedDuration,
      actual_duration: null,
      generated_text: allLines.join('\n'),
    })
    .execute();

  const lineIds: string[] = [];
  let lineOrd = 0;
  for (let si = 0; si < data.script.sections.length; si += 1) {
    const sec = data.script.sections[si] as SeedData['script']['sections'][number];
    const sectionId = seedId('sec', `${data.script.key}:${sec.kind}`);
    await db
      .insertInto('script_section')
      .values({
        id: sectionId,
        script_id: scriptId,
        kind: sec.kind,
        ord: si + 1,
        range_start: sec.rangeStart,
        range_end: sec.rangeEnd,
      })
      .execute();
    for (let li = 0; li < sec.lines.length; li += 1) {
      lineOrd += 1;
      const lineId = seedId('l', `${data.script.key}:${lineOrd}`);
      lineIds.push(lineId);
      await db
        .insertInto('script_line')
        .values({
          id: lineId,
          section_id: sectionId,
          ord: li + 1,
          text: sec.lines[li] as string,
          edited_by_user: 0,
          // char_count 是 STORED 生成列，刻意不写：由 DB 算 CHAR_LENGTH(`text`)。
        })
        .execute();
    }
  }

  await db
    .insertInto('script_revision')
    .values({
      id: seedId('rev', `${data.script.key}:1`),
      script_id: scriptId,
      version: 1,
      diff: toJsonParam(
        allLines.map((text, i) => ({ lineId: lineIds[i] as string, before: '', after: text })),
      ),
      reason: 'generate',
      snapshot: toJsonParam({ sections: data.script.sections, lines: allLines }),
    })
    .execute();

  // ── ⑩ 配额：total 60 / used 22 / reserved 0 / left 38 ──
  const resetAt = utcLiteral(nextMonthStart(now));
  await db
    .insertInto('quota_account')
    .values({
      user_id: userId,
      plan_id: data.quota.planId,
      total: data.quota.total,
      used: data.quota.used,
      reserved: data.quota.reserved,
      reset_at: resetAt,
      version: '0',
    })
    .execute();

  await db
    .insertInto('quota_ledger')
    .values({
      user_id: userId,
      work_id: null,
      job_id: null,
      reservation_id: null,
      action: 'grant',
      points: data.quota.total,
      balance_after: data.quota.total,
      idempotency_key: `seed-grant-${data.user.key}`,
      note: '套餐开通 ¥168/月 60 点',
      created_at: at(60 * 24 * 30),
    })
    .execute();

  let balance = data.quota.total;
  for (let i = 0; i < data.quota.commitWorkKeys.length; i += 1) {
    balance -= data.quota.hdPointsPerRender;
    await db
      .insertInto('quota_ledger')
      .values({
        user_id: userId,
        work_id: workIdOf.get(data.quota.commitWorkKeys[i] as string) as string,
        job_id: null,
        reservation_id: null,
        action: 'commit',
        points: data.quota.hdPointsPerRender,
        balance_after: balance,
        idempotency_key: `seed-commit-${data.user.key}-${i + 1}`,
        note: '高清渲染结算 2 点/条',
        created_at: at(60 * 24 * (30 - i)),
      })
      .execute();
  }

  // ── ⑧ 平台规则 4（每平台恰好一个当前版本，由 current_flag 唯一索引保证）──
  for (const r of data.platformRules) {
    await db
      .insertInto('platform_rule')
      .values({
        platform_id: r.platformId,
        version: r.version,
        name: r.name,
        ratio: r.ratio,
        max_duration: r.maxDuration,
        orient: r.orient,
        brand_color: r.brandColor,
        style_hint: r.styleHint,
        title_max: r.titleMax,
        title_hard_max: r.titleHardMax,
        tag_max: r.tagMax,
        banned_patterns: toJsonParam(r.bannedPatterns),
        is_current: r.isCurrent,
      })
      .execute();
  }

  // ── 音色 4 / 模板 4 ──
  for (const v of data.voices) {
    await db
      .insertInto('voice_catalog')
      .values({
        id: v.id,
        provider: v.provider,
        name: v.name,
        gender: v.gender,
        timbre: v.timbre,
        sample_layer_key: `fixture://voice/${v.id}/sample.mp3`,
        // NOT NULL 约束满足，但这是**占位凭证**，不是真实商用授权（R4 待 T-36 补齐）。
        license_evidence: toJsonParam({
          type: 'placeholder',
          status: 'pending',
          note: 'fixture 占位，真实商用凭证待 T-36',
        }),
        is_active: 1,
        ord: v.ord,
      })
      .execute();
  }

  for (const t of data.templates) {
    await db
      .insertInto('template_catalog')
      .values({
        id: t.id,
        name: t.name,
        version: t.version,
        palette: toJsonParam(t.palette),
        font_family: t.fontFamily,
        // SPEC 只命名了 4 个页型，架构要求 6 个 → 余 2 个未命名，不编造，列 [待确认]。
        page_types: toJsonParam(data.pageTypes),
        orients: toJsonParam(['vertical', 'horizontal']),
        manifest_key: `fixture://template/${t.id}/manifest.json`,
        is_active: 1,
      })
      .execute();
  }

  // ── ⑪ 热点 3（与 h1/h2/h3 同源）──
  for (const tr of data.trends) {
    await db
      .insertInto('trend')
      .values({
        id: seedId('tr', tr.key),
        domain: tr.domain,
        name: tr.name,
        heat: tr.heat === null ? null : String(tr.heat),
        lifecycle: tr.lifecycle,
        window_hours: tr.windowHours,
        angles: toJsonParam([]),
        source: tr.source,
        fetched_at: at(60),
      })
      .execute();
  }

  return { applied: true, userId, counts: await measureSeedCounts(db, userId) };
}

/** 与 domain.STEP_META 的 phase 口径一致（progress 不入库，phase 入库）。 */
function phaseOfStep(step: WorkStep): number {
  switch (step) {
    case 'search':
      return 0;
    case 'topics':
    case 'script':
      return 1;
    case 'video.draft':
    case 'video.rendering':
    case 'video.rendered':
      return 2;
    case 'derive':
    case 'export':
      return 3;
    case 'done':
      return 4;
  }
}

function nextMonthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));
}
