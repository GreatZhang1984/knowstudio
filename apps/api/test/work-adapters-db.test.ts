/**
 * 两个跨 Task 端口的**真实 MySQL 8.4 集成证明**（T-12 快照聚合 / T-42·T-43 配额读取）。
 *
 * 被测对象是 packages/db 的真实 DB 适配器：
 *   createWorkQuotaReader(db)        → 读 quota_account，left 派生，fail-closed
 *   createWorkTruthSnapshotLoader(db)→ 多表聚合真相，闸门交 domain.deriveGates 重算
 *
 * ## 为什么在 apps/api/test 而不是 packages/db/test
 * G4 用例要用 domain.complianceFingerprint 算「匹配指纹」，而 packages/db 不依赖 domain
 * （依赖边界）。apps/api 同时依赖 db + domain，故集成测试落在这里，与 works-repository.test.ts
 * / user-store-db.test.ts 同一约定：走 @knowstudio/db 的 createDb() 拿真实 Kysely + mysql2 pool，
 * **不 import kysely**（apps/api 未声明该依赖），只用 typed query builder。
 *
 * ## 不污染共享种子（与 mysql-integration.test.ts 并行安全）
 * mysql-integration 的 measureSeedCounts 对 script/material/work_material/topic/quota_ledger 等
 * 做**全局** COUNT。故本文件的探针只写 video_asset / compliance_report / derivative —— 这三张表
 * 不在任何全局计数里，且全部在 afterAll 精确删除。绝不建表 / 跑迁移 / 改种子（DB 已 provisioning）。
 *
 * ## 证据口径
 *  - 配额：读真实种子账本（60/22/0→left 38），并证明缺账本行**抛错**而非默认 0（D-22）。
 *  - 快照 contentHash：与 script.generated_text 的 sha256 **独立比对**（不同列、同一真相），
 *    证明取的是真实正文而非编造。
 *  - 闸门：G1/G2 由种子真相派生；G3/G4 用探针证明「随真相翻转」，不是硬编码（D-04）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { createDb, toJsonParam, type DbHandle } from '@knowstudio/db';
import {
  createWorkQuotaReader,
  createWorkTruthSnapshotLoader,
  QuotaAccountMissingError,
  type WorkRow,
} from '@knowstudio/db/repositories';
import { complianceFingerprint, deriveGates } from '@knowstudio/domain';

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const HEX64 = /^[0-9a-f]{64}$/;

let handle: DbHandle;
let db: DbHandle['db'];
let userId: string;
let w1: WorkRow; // 有文案 + 选中选题的作品（种子 w1）
let bareWork: WorkRow; // 无文案、无选题的作品（种子 w2/w3）
let scriptId: string;
let scriptGeneratedText: string;
let templateId: string;
let platformId: string;
let ruleVersion: number;

// 探针 id（run 唯一），afterAll 精确删除。
const suffix = randomUUID().replace(/-/g, '').slice(0, 16);
const vaId = `wprobe_va_${suffix}`;
const dvId = `wprobe_dv_${suffix}`;
const crIds = [`wprobe_cr0_${suffix}`, `wprobe_cr1_${suffix}`, `wprobe_cr2_${suffix}`];

const quota = () => createWorkQuotaReader(db);
const loader = () => createWorkTruthSnapshotLoader(db);

beforeAll(async () => {
  handle = createDb({ connectionLimit: 4 });
  db = handle.db;

  // 动态发现种子（不硬编码具体值，DB 未 provisioning 时大声失败）。
  const account = await db.selectFrom('quota_account').select('user_id').executeTakeFirst();
  expect(account, '库里没有 quota_account，种子未落库').toBeDefined();
  userId = account!.user_id;

  const script = await db
    .selectFrom('script')
    .select(['id', 'work_id', 'generated_text'])
    .where('user_id', '=', userId)
    .executeTakeFirst();
  expect(script, '种子里没有文案行').toBeDefined();
  scriptId = script!.id;
  // generated_text 列可空，但种子恒写 allLines.join('\n')；据实断言非空后再取。
  expect(script!.generated_text, '种子文案 generated_text 不应为 null').not.toBeNull();
  scriptGeneratedText = script!.generated_text!;

  w1 = await db
    .selectFrom('work')
    .selectAll()
    .where('id', '=', script!.work_id)
    .executeTakeFirstOrThrow();

  const bare = await db
    .selectFrom('work')
    .selectAll()
    .where('user_id', '=', userId)
    .where('id', '!=', w1.id)
    .where('selected_topic_id', 'is', null)
    .executeTakeFirst();
  expect(bare, '种子里没有「无选题」作品可供 G1 负向对照').toBeDefined();
  bareWork = bare!;

  const tpl = await db.selectFrom('template_catalog').select('id').executeTakeFirst();
  expect(tpl, '没有模板目录行').toBeDefined();
  templateId = tpl!.id;

  const rule = await db
    .selectFrom('platform_rule')
    .select(['platform_id', 'version'])
    .where('is_current', '=', 1)
    .executeTakeFirst();
  expect(rule, '没有当前平台规则').toBeDefined();
  platformId = rule!.platform_id;
  ruleVersion = rule!.version;
}, 60_000);

afterAll(async () => {
  if (db !== undefined) {
    // FK 安全顺序：先子（compliance/derivative 引用 work/user）后 video_asset。
    await db.deleteFrom('compliance_report').where('id', 'in', crIds).execute();
    await db.deleteFrom('derivative').where('id', '=', dvId).execute();
    await db.deleteFrom('video_asset').where('id', '=', vaId).execute();
  }
  await handle?.destroy();
}, 60_000);

describe('WORK_QUOTA_READER · 真实 quota_account（fail-closed，杜绝 D-22）', () => {
  it('读种子账本：total/used/reserved 实测，left 派生 = 38，resetAt 归一化为 ISO UTC', async () => {
    const q = await quota().readForUser(userId);
    expect(q.total).toBe(60);
    expect(q.used).toBe(22);
    expect(q.reserved).toBe(0);
    expect(q.left).toBe(38);
    expect(q.left).toBe(q.total - q.used - q.reserved);
    expect(q.resetAt).toMatch(ISO_UTC);
  });

  it('缺账本行 → 抛 QUOTA_ACCOUNT_MISSING，绝不退化成默认 0 点 / 默认满额度', async () => {
    let code: string | undefined;
    try {
      await quota().readForUser(`u_ghost_${suffix}`);
    } catch (err) {
      code = (err as { code?: string }).code;
    }
    expect(code).toBe('QUOTA_ACCOUNT_MISSING');
    expect(QuotaAccountMissingError.name).toBe('QuotaAccountMissingError');
  });
});

describe('WORK_TRUTH_SNAPSHOT · 只读种子真相（G1/G2 由真实数据派生）', () => {
  it('w1：选中选题 + draft 文案 + 2 条引用素材；无 hd/合规/派生/模板/bgm', async () => {
    const s = await loader().load(w1);
    expect(s.workId).toBe(w1.id);
    expect(s.selectedTopicId).toBe(w1.selected_topic_id);
    expect(s.selectedTopicId).not.toBeNull();
    expect(s.script).not.toBeNull();
    expect(s.script!.id).toBe(scriptId);
    expect(s.script!.version).toBe(1);
    expect(s.script!.status).toBe('draft');
    expect(s.script!.confirmedAt).toBeNull();
    expect(s.script!.contentHash).toMatch(HEX64);
    expect(s.latestHdAsset).toBeNull();
    expect(s.latestCompliance).toBeNull();
    expect(s.derivatives).toEqual([]);
    expect(s.template).toBeNull();
    expect(s.bgm).toBeNull();
    expect(s.lexiconVersion).toBe(0);
    // 种子初始收藏 {k1,h1} → 2 条引用素材，授权态据实读出。
    expect(s.materials).toHaveLength(2);
    for (const m of s.materials) {
      expect(typeof m.materialId).toBe('string');
      expect(Number.isInteger(m.licenseEvidenceVersion)).toBe(true);
    }
  });

  it('contentHash 与 script.generated_text 的 sha256 独立相符（取真实正文，非编造）', async () => {
    const s = await loader().load(w1);
    const independent = createHash('sha256').update(scriptGeneratedText, 'utf8').digest('hex');
    expect(s.script!.contentHash).toBe(independent);
  });

  it('deriveGates(种子 w1) = G1 真 / G2 假（draft 未确认）/ G3 假 / G4 假', async () => {
    const gates = deriveGates(await loader().load(w1));
    expect(gates).toEqual({ G1: true, G2: false, G3: false, G4: false });
  });

  it('无选题作品：selectedTopicId 为 null → G1 假（负向对照，证明不是恒真）', async () => {
    const s = await loader().load(bareWork);
    expect(s.selectedTopicId).toBeNull();
    expect(s.script).toBeNull();
    expect(deriveGates(s).G1).toBe(false);
  });
});

describe('WORK_TRUTH_SNAPSHOT · G3 随 hd 母版真相翻转（探针 video_asset，安全表）', () => {
  it('succeeded + 未陈旧 + scriptVersion 匹配 → latestHdAsset 据实 + 模板字体聚合 + G3 真', async () => {
    await db
      .insertInto('video_asset')
      .values({
        id: vaId,
        work_id: w1.id,
        user_id: userId,
        quality: 'hd',
        status: 'succeeded',
        script_version: 1,
        stale: 0,
        template_id: templateId,
        speed: '1.0',
      })
      .execute();
    try {
      const s = await loader().load(w1);
      expect(s.latestHdAsset).not.toBeNull();
      expect(s.latestHdAsset!.id).toBe(vaId);
      expect(s.latestHdAsset!.status).toBe('succeeded');
      expect(s.latestHdAsset!.stale).toBe(false);
      expect(s.latestHdAsset!.scriptVersion).toBe(1);
      // 模板经 hd asset.template_id 引用 template_catalog，字体据实聚合。
      expect(s.template).not.toBeNull();
      expect(s.template!.templateId).toBe(templateId);
      expect(typeof s.template!.fontFamily).toBe('string');
      expect(deriveGates(s).G3).toBe(true);
    } catch (err) {
      await db.deleteFrom('video_asset').where('id', '=', vaId).execute();
      throw err;
    }
  });

  it('母版陈旧 stale=1 → G3 假（即便 succeeded 且版本匹配）', async () => {
    await db.updateTable('video_asset').set({ stale: 1 }).where('id', '=', vaId).execute();
    const s = await loader().load(w1);
    expect(s.latestHdAsset!.stale).toBe(true);
    expect(deriveGates(s).G3).toBe(false);
  });

  it('scriptVersion 与当前文案不一致（2≠1）→ G3 假', async () => {
    await db
      .updateTable('video_asset')
      .set({ stale: 0, script_version: 2 })
      .where('id', '=', vaId)
      .execute();
    const s = await loader().load(w1);
    expect(s.latestHdAsset!.scriptVersion).toBe(2);
    expect(deriveGates(s).G3).toBe(false);
    // 复位供后续 G4 用例使用（G4 不依赖 G3，但保持 hd 母版匹配以聚合模板）。
    await db
      .updateTable('video_asset')
      .set({ script_version: 1 })
      .where('id', '=', vaId)
      .execute();
  });
});

describe('WORK_TRUTH_SNAPSHOT · G4 随合规报告真相翻转（探针 derivative + compliance_report）', () => {
  it('派生据实聚合（platformId/ruleVersion/title/tags）', async () => {
    await db
      .insertInto('derivative')
      .values({
        id: dvId,
        work_id: w1.id,
        user_id: userId,
        platform_id: platformId,
        rule_version: ruleVersion,
        title: '探针平台标题',
        tags: toJsonParam(['探针标签']),
      })
      .execute();
    const s = await loader().load(w1);
    expect(s.derivatives).toHaveLength(1);
    expect(s.derivatives[0]).toEqual({
      platformId,
      ruleVersion,
      title: '探针平台标题',
      tags: ['探针标签'],
    });
  });

  it('blocking_count=0 且指纹匹配 → G4 真（指纹由 domain.complianceFingerprint 实算）', async () => {
    const fp = complianceFingerprint(await loader().load(w1));
    expect(fp).toMatch(HEX64);
    await db
      .insertInto('compliance_report')
      .values({
        id: crIds[0]!,
        work_id: w1.id,
        user_id: userId,
        items: toJsonParam([]),
        blocking_count: 0,
        fingerprint: fp,
      })
      .execute();
    const s = await loader().load(w1);
    expect(s.latestCompliance).not.toBeNull();
    expect(s.latestCompliance!.blockingCount).toBe(0);
    expect(s.latestCompliance!.fingerprint).toBe(fp);
    expect(deriveGates(s).G4).toBe(true);
  });

  it('blocking_count>0（指纹仍匹配）→ G4 假（隔离出「阻断项」这一原因）', async () => {
    const fp = complianceFingerprint(await loader().load(w1));
    await db.deleteFrom('compliance_report').where('id', '=', crIds[0]!).execute();
    await db
      .insertInto('compliance_report')
      .values({
        id: crIds[1]!,
        work_id: w1.id,
        user_id: userId,
        items: toJsonParam([]),
        blocking_count: 1,
        fingerprint: fp,
      })
      .execute();
    const s = await loader().load(w1);
    expect(s.latestCompliance!.blockingCount).toBe(1);
    expect(deriveGates(s).G4).toBe(false);
  });

  it('指纹陈旧（不匹配当前真相）→ G4 假（防陈旧放行，架构 §8.4）', async () => {
    await db.deleteFrom('compliance_report').where('id', '=', crIds[1]!).execute();
    await db
      .insertInto('compliance_report')
      .values({
        id: crIds[2]!,
        work_id: w1.id,
        user_id: userId,
        items: toJsonParam([]),
        blocking_count: 0,
        fingerprint: '0'.repeat(64),
      })
      .execute();
    const s = await loader().load(w1);
    expect(s.latestCompliance!.fingerprint).toBe('0'.repeat(64));
    expect(s.latestCompliance!.fingerprint).not.toBe(complianceFingerprint(s));
    expect(deriveGates(s).G4).toBe(false);
  });
});