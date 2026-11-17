/**
 * 种子不变量测试（SPEC §4.3：3 作品 / 10 素材 / 12 角度 / 212 字 / 配额 60-22）。
 *
 * 纪律：所有计数都从 fixtures/seed.json **独立重算**，不采信 SEED_EXPECTATIONS 自身，
 * 否则「期望值写错 + 校验用同一份期望值」会双双通过而毫无意义。
 * 负向用例逐条破坏 SPEC 约束，证明 validateSeedData 真的会拦，而不是装饰。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SEED_EXPECTATIONS,
  SeedInvariantError,
  loadSeedData,
  seedId,
  utcLiteral,
  validateSeedData,
} from '../migrations/seed.js';
import type { SeedData } from '../migrations/seed.js';

const SEED_PATH = fileURLToPath(new URL('../../../fixtures/seed.json', import.meta.url));
const raw = readFileSync(SEED_PATH, 'utf8');
const data = loadSeedData(SEED_PATH);
const clone = (): SeedData => structuredClone(data);

/** 独立重算：码点计数（与 MySQL CHAR_LENGTH 对齐），不用 .length。 */
const allLines = (d: SeedData): string[] => d.script.sections.flatMap((s) => s.lines);
const charCount = (d: SeedData): number => allLines(d).reduce((n, l) => n + [...l].length, 0);

function expectSeedViolation(mutate: (d: SeedData) => void, fragment: string): void {
  const d = clone();
  mutate(d);
  let caught: unknown;
  try {
    validateSeedData(d);
  } catch (err) {
    caught = err;
  }
  expect(caught, `扰动未被拦截：${fragment}`).toBeInstanceOf(SeedInvariantError);
  const err = caught as SeedInvariantError;
  expect(err.code).toBe('SEED_INVARIANT_VIOLATION');
  expect(err.problems.join('\n')).toContain(fragment);
}

describe('fixtures/seed.json · 独立重算 SPEC §4.3 计数', () => {
  it('文件是合法 JSON 且能被 loadSeedData 解析', () => {
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(data.meta.task).toContain('T-03');
  });

  it('真实种子通过校验', () => {
    expect(() => validateSeedData(data)).not.toThrow();
  });

  it('作品 3 / 素材 10 / 素材库 8 / 收藏 2 / 选题 12', () => {
    expect(data.works).toHaveLength(3);
    expect(data.materials).toHaveLength(10);
    expect(data.materials.filter((m) => m.library)).toHaveLength(8);
    expect(data.collected).toHaveLength(2);
    expect(data.topics).toHaveLength(12);
  });

  it('文案 3 段 10 行，行数分布 2/6/2，总字数恰好 212', () => {
    expect(data.script.sections).toHaveLength(3);
    expect(data.script.sections.map((s) => s.lines.length)).toEqual([2, 6, 2]);
    expect(allLines(data)).toHaveLength(10);
    expect(charCount(data)).toBe(212);
  });

  it('预估时长 50 = round(212/4.2)（SPEC 的语速口径）', () => {
    expect(data.script.estimatedDuration).toBe(50);
    expect(Math.round(charCount(data) / 4.2)).toBe(50);
  });

  it('文案不含非 BMP 字符：JS 码点数与 MySQL CHAR_LENGTH 必须一致', () => {
    // char_count 是 STORED 生成列 AS CHAR_LENGTH(text)。若含 astral 字符，
    // UTF-16 的 .length 会与 CHAR_LENGTH 打架，212 这个验收数字就不可比。
    for (const line of allLines(data)) {
      expect([...line].length).toBe(line.length);
      expect(/[\uD800-\uDFFF]/.test(line)).toBe(false);
    }
  });

  it('配额 60-22-0，余 38，高清单价 2，commit 点数合计 = used', () => {
    expect(data.quota.total).toBe(60);
    expect(data.quota.used).toBe(22);
    expect(data.quota.reserved).toBe(0);
    expect(data.quota.total - data.quota.used - data.quota.reserved).toBe(38);
    expect(data.quota.hdPointsPerRender).toBe(2);
    expect(data.quota.commitWorkKeys).toHaveLength(11);
    expect(data.quota.commitWorkKeys.length * data.quota.hdPointsPerRender).toBe(22);
  });

  it('目录数据：4 音色 / 4 模板 / 4 平台规则 / 3 热点 / 3 空白角度', () => {
    expect(data.voices).toHaveLength(4);
    expect(data.templates).toHaveLength(4);
    expect(data.platformRules).toHaveLength(4);
    expect(data.trends).toHaveLength(3);
    expect(data.search.blankAngles).toHaveLength(3);
  });

  it('SEED_EXPECTATIONS 与独立重算结果逐项一致（防止期望值自身写错）', () => {
    expect(SEED_EXPECTATIONS.works).toBe(data.works.length);
    expect(SEED_EXPECTATIONS.materials).toBe(data.materials.length);
    expect(SEED_EXPECTATIONS.libraryMaterials).toBe(data.materials.filter((m) => m.library).length);
    expect(SEED_EXPECTATIONS.collected).toBe(data.collected.length);
    expect(SEED_EXPECTATIONS.topics).toBe(data.topics.length);
    expect(SEED_EXPECTATIONS.scriptSections).toBe(data.script.sections.length);
    expect(SEED_EXPECTATIONS.scriptLines).toBe(allLines(data).length);
    expect(SEED_EXPECTATIONS.scriptChars).toBe(charCount(data));
    expect(SEED_EXPECTATIONS.sectionLineCounts).toEqual(data.script.sections.map((s) => s.lines.length));
    expect(SEED_EXPECTATIONS.estimatedDuration).toBe(data.script.estimatedDuration);
    expect(SEED_EXPECTATIONS.quotaTotal).toBe(data.quota.total);
    expect(SEED_EXPECTATIONS.quotaUsed).toBe(data.quota.used);
    expect(SEED_EXPECTATIONS.quotaReserved).toBe(data.quota.reserved);
    expect(SEED_EXPECTATIONS.quotaLeft).toBe(data.quota.total - data.quota.used - data.quota.reserved);
    expect(SEED_EXPECTATIONS.voices).toBe(data.voices.length);
    expect(SEED_EXPECTATIONS.templates).toBe(data.templates.length);
    expect(SEED_EXPECTATIONS.platformRules).toBe(data.platformRules.length);
    expect(SEED_EXPECTATIONS.trends).toBe(data.trends.length);
    expect(SEED_EXPECTATIONS.blankAngles).toBe(data.search.blankAngles.length);
  });

  it('SPEC 原文锚点：t01 与 t12 的 hook/angle 逐字一致', () => {
    const t01 = data.topics.find((t) => t.key === 't01');
    const t12 = data.topics.find((t) => t.key === 't12');
    expect(t01?.hook).toBe('为什么你学了就忘？大脑在骗你');
    expect(t01?.angle).toBe('反常识切入·记忆机制');
    expect(t12?.hook).toBe('把知识『翻译』成人话的能力，值多少钱');
    expect(t12?.angle).toBe('价值升华·职场竞争力');
  });

  it('种子文件不含任何真实外链，素材凭证一律 fixture:// 占位', () => {
    expect(raw).not.toMatch(/https?:\/\//);
    const evidences = data.materials.map((m) => m.licenseEvidence).filter((e) => e !== null);
    expect(evidences.length).toBeGreaterThan(0);
    for (const e of evidences) expect(JSON.stringify(e)).toContain('fixture://');
  });

  it('音色占位凭证由 applySeed 构造，不在种子里伪造授权（R4 待 T-36）', () => {
    // voices 接口刻意不含 licenseEvidence 字段：真实商用凭证尚未取得，
    // 落库时写 {type:'placeholder',status:'pending'}，由集成测试查真实库行验证。
    for (const v of data.voices) expect(v).not.toHaveProperty('licenseEvidence');
    expect(data.voices.every((v) => v.id.length > 0 && v.provider.length > 0)).toBe(true);
  });

  it('gates 缓存与可派生真相一致：w2/w3 无 script 行，故不得声称 G2 通过', () => {
    // deriveGates 的 G2 读 script.status/confirmedAt；种子里只有 w1 有文案行。
    // 若给 w2/w3 写 G2:true 就是「缓存与真相打架」——正是架构要消灭的 D-04 类缺陷。
    const w1 = data.works.find((w) => w.key === 'w1');
    expect(w1?.gates.G1).toBe(true);
    for (const key of ['w2', 'w3']) {
      const w = data.works.find((x) => x.key === key);
      expect(w?.gates).toEqual({ G1: false, G2: false, G3: false, G4: false });
      expect(w?.scriptConfirmed).toBe(false);
    }
    expect(data.script.workKey).toBe('w1');
  });
});

describe('validateSeedData · 负向：破坏 SPEC 约束必须被拦', () => {
  it('少一个作品', () => {
    expectSeedViolation((d) => d.works.pop(), '作品数');
  });
  it('少一条素材', () => {
    expectSeedViolation((d) => d.materials.pop(), '素材数');
  });
  it('素材库条目数不符（把一条库内素材改成公共库）', () => {
    expectSeedViolation((d) => {
      const m = d.materials.find((x) => x.library);
      if (m !== undefined) m.library = false;
    }, '素材库条目数');
  });
  it('收藏数不符', () => {
    expectSeedViolation((d) => d.collected.pop(), '初始收藏数');
  });
  it('选题数不足 12', () => {
    expectSeedViolation((d) => d.topics.pop(), '选题数');
  });
  it('文案段数不符', () => {
    expectSeedViolation((d) => d.script.sections.pop(), '文案段数');
  });
  it('文案行数不符', () => {
    expectSeedViolation((d) => d.script.sections[0]?.lines.pop(), '文案行数');
  });
  it('段内行数分布不符（2/6/2 被破坏）', () => {
    expectSeedViolation((d) => {
      const from = d.script.sections[0]?.lines.pop();
      if (from !== undefined) d.script.sections[1]?.lines.push(from);
    }, '第 1 段行数');
  });
  it('字数多 1 个（212→213）', () => {
    expectSeedViolation((d) => {
      const s = d.script.sections[0];
      if (s !== undefined && s.lines[0] !== undefined) s.lines[0] += '字';
    }, '文案字数');
  });
  it('字数少 1 个（212→211）', () => {
    expectSeedViolation((d) => {
      const s = d.script.sections[0];
      if (s !== undefined && s.lines[0] !== undefined) s.lines[0] = [...s.lines[0]].slice(0, -1).join('');
    }, '文案字数');
  });
  it('预估时长与字数不自洽', () => {
    expectSeedViolation((d) => {
      d.script.estimatedDuration = 60;
    }, '预估时长');
  });
  it('配额 total 不符', () => {
    expectSeedViolation((d) => {
      d.quota.total = 50;
    }, '配额 total');
  });
  it('配额 used 不符（22→23）', () => {
    expectSeedViolation((d) => {
      d.quota.used = 23;
    }, '配额 used');
  });
  it('配额 reserved 非 0', () => {
    expectSeedViolation((d) => {
      d.quota.reserved = 1;
    }, '配额 reserved');
  });
  it('高清单价不符', () => {
    expectSeedViolation((d) => {
      d.quota.hdPointsPerRender = 3;
    }, '高清单价');
  });
  it('commit 点数合计与 used 不自洽', () => {
    expectSeedViolation((d) => d.quota.commitWorkKeys.pop(), 'commit 点数合计');
  });
  it('音色/模板/平台规则/热点/空白角度数量不符', () => {
    expectSeedViolation((d) => d.voices.pop(), '音色数');
    expectSeedViolation((d) => d.templates.pop(), '模板数');
    expectSeedViolation((d) => d.platformRules.pop(), '平台规则数');
    expectSeedViolation((d) => d.trends.pop(), '热点数');
    expectSeedViolation((d) => d.search.blankAngles.pop(), '空白角度数');
  });
});

describe('validateSeedData · 负向：悬空引用必须被拦', () => {
  it('收藏引用不存在的素材', () => {
    expectSeedViolation((d) => {
      d.collected[0] = 'nope';
    }, '收藏引用了不存在的素材 nope');
  });
  it('选题 basis 为空（违反 ck_topic_basis）', () => {
    expectSeedViolation((d) => {
      const t = d.topics[0];
      if (t !== undefined) t.basis = [];
    }, 'basis 为空');
  });
  it('选题引用不存在的素材', () => {
    expectSeedViolation((d) => {
      const t = d.topics[0];
      if (t !== undefined) t.basis = ['ghost'];
    }, '引用了不存在的素材 ghost');
  });
  it('作品选中不存在的选题', () => {
    expectSeedViolation((d) => {
      const w = d.works[0];
      if (w !== undefined) w.selectedTopicKey = 'ghost';
    }, '选中了不存在的选题 ghost');
  });
  it('账本引用不存在的作品', () => {
    expectSeedViolation((d) => {
      d.quota.commitWorkKeys[0] = 'ghost';
    }, '账本引用了不存在的作品 ghost');
  });
  it('选题批引用不存在的素材', () => {
    expectSeedViolation((d) => {
      d.topicBatch.basedOnMaterialKeys[0] = 'ghost';
    }, '选题批引用了不存在的素材 ghost');
  });
  it('热点引用不存在的素材', () => {
    expectSeedViolation((d) => {
      const t = d.trends[0];
      if (t !== undefined) t.materialKey = 'ghost';
    }, '热点引用了不存在的素材 ghost');
  });
  it('一次报全所有问题', () => {
    const d = clone();
    d.works.pop();
    d.topics.pop();
    d.quota.used = 99;
    let caught: unknown;
    try {
      validateSeedData(d);
    } catch (err) {
      caught = err;
    }
    expect((caught as SeedInvariantError).problems.length).toBeGreaterThanOrEqual(3);
  });
});

describe('seedId · 确定性 ULID 风格 ID', () => {
  it('同 key 同前缀必然得到同一 ID（可复现）', () => {
    expect(seedId('u', 'u1')).toBe(seedId('u', 'u1'));
  });
  it('不同 key 得到不同 ID', () => {
    expect(seedId('w', 'w1')).not.toBe(seedId('w', 'w2'));
  });
  it('不同前缀得到不同 ID', () => {
    expect(seedId('w', 'x')).not.toBe(seedId('m', 'x'));
  });
  it('形态为 prefix_ + 26 位 Crockford base32，且不超过 CHAR(36)', () => {
    const id = seedId('u', 'u1');
    expect(id).toMatch(/^u_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(id.length).toBeLessThanOrEqual(36);
  });
  it('排除易混字符 I/L/O/U', () => {
    for (const key of ['u1', 'w1', 'w2', 'w3', 'k1', 't01', 't12', 'sc1']) {
      const body = seedId('x', key).slice(2);
      expect(body).not.toMatch(/[ILOU]/);
    }
  });
  it('前缀长度变化时仍不超过 36（最长前缀 tmpl/voice 等）', () => {
    for (const p of ['u', 'w', 'm', 'wm', 'ss', 'tb', 't', 'sc', 'sec', 'ln', 'rev', 'qa', 'ql', 'pr', 'v', 'tpl', 'tr']) {
      expect(seedId(p, 'some-key').length).toBeLessThanOrEqual(36);
    }
  });
});

describe('utcLiteral · DATETIME(3) 的 UTC 字面量', () => {
  it('格式为 YYYY-MM-DD HH:MM:SS.mmm，无 T 无 Z', () => {
    expect(utcLiteral(new Date(Date.UTC(2026, 10, 13, 8, 9, 10, 123)))).toBe('2026-11-13 08:09:10.123');
  });
  it('毫秒补零到 3 位', () => {
    expect(utcLiteral(new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 7)))).toBe('2026-01-01 00:00:00.007');
  });
  it('按 UTC 而非本地时区渲染（本机时区无关）', () => {
    const d = new Date('2026-11-13T23:59:59.999Z');
    expect(utcLiteral(d)).toBe('2026-11-13 23:59:59.999');
  });
});