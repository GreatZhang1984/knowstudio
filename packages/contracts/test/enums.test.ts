import { describe, expect, it } from 'vitest';
import {
  DB_ENUMS,
  DeriveScope,
  GateId,
  PHASES,
  Phase,
  PlatformId,
} from '../src/enums.js';

/**
 * 期望值逐字抄自架构 §4.2 枚举表（顺序即 MySQL ENUM 声明顺序）。
 * 这份表是 T-03 迁移生成器的输入，也是「前后端与 E2E 共用同一份枚举」的验收依据。
 */
const EXPECTED: Record<string, readonly string[]> = {
  WorkStep: ['search', 'topics', 'script', 'video.draft', 'video.rendering', 'video.rendered', 'derive', 'export', 'done'],
  MaterialType: ['knowledge', 'hot', 'peer', 'image', 'doc', 'music', 'font'],
  LicenseState: ['cleared', 'restricted', 'unknown'],
  ScriptStatus: ['draft', 'confirmed', 'stale'],
  SectionKind: ['hook3s', 'body', 'outro'],
  RevisionReason: ['generate', 'edit', 'restyle', 'accept', 'reject', 'unlock'],
  HunkStatus: ['pending', 'accepted', 'rejected'],
  AssetQuality: ['draft', 'hd', 'uhd4k'],
  LayerKind: ['audio', 'slides', 'subtitles', 'timeline', 'bgm', 'cover'],
  JobType: ['draft', 'hd', 'patch', 'derive_media', 'export', 'search', 'topics', 'script', 'restyle'],
  JobStatus: ['queued', 'running', 'succeeded', 'failed', 'canceled'],
  DurationVersion: ['full', 'essence30', 'teaser15'],
  ComplianceKind: ['image', 'music', 'font', 'content'],
  ComplianceState: ['pass', 'warn', 'block'],
  QuotaAction: ['grant', 'reserve', 'commit', 'release', 'reset', 'adjust'],
  ReservationState: ['held', 'committed', 'released', 'expired'],
  TrendLifecycle: ['rising', 'peaked', 'faded'],
  QueueState: ['pending', 'leased', 'done', 'dead', 'canceled'],
};

describe('DB 枚举值域与架构 §4.2 逐字一致', () => {
  it('恰好 18 个落库枚举，无遗漏无多余', () => {
    expect(Object.keys(DB_ENUMS).sort()).toEqual(Object.keys(EXPECTED).sort());
    expect(Object.keys(DB_ENUMS)).toHaveLength(18);
  });

  for (const [name, values] of Object.entries(EXPECTED)) {
    it(`${name} 值与顺序完全一致`, () => {
      const schema = DB_ENUMS[name as keyof typeof DB_ENUMS];
      expect([...schema.values]).toEqual([...values]);
      expect(schema.options).toEqual([...values]);
    });
  }

  it('每个枚举都拒绝域外值', () => {
    for (const schema of Object.values(DB_ENUMS)) {
      expect(schema.safeParse('__not_a_value__').success).toBe(false);
      expect(schema.safeParse('').success).toBe(false);
    }
  });

  it('每个枚举都接受自己的全部值', () => {
    for (const schema of Object.values(DB_ENUMS)) {
      for (const v of schema.values) expect(schema.parse(v)).toBe(v);
    }
  });
});

describe('非落库枚举', () => {
  it('四平台 id 与架构 platform_rule 种子一致', () => {
    expect([...PlatformId.values]).toEqual(['douyin', 'sph', 'bili', 'xhs']);
  });

  it('可派生闸门只有 G1–G4；G5 是静态禁令不是门', () => {
    expect([...GateId.values]).toEqual(['G1', 'G2', 'G3', 'G4']);
    expect(GateId.safeParse('G5').success).toBe(false);
  });

  it('派生二分 metadata / media（A1 收窄）', () => {
    expect([...DeriveScope.values]).toEqual(['metadata', 'media']);
  });

  it('Phase 为 0–4 五段', () => {
    expect([...PHASES]).toEqual([0, 1, 2, 3, 4]);
    for (const p of PHASES) expect(Phase.parse(p)).toBe(p);
    expect(Phase.safeParse(5).success).toBe(false);
    expect(Phase.safeParse(-1).success).toBe(false);
    expect(Phase.safeParse('2').success).toBe(false);
  });
});

describe('枚举只许追加、永不重排（MySQL INPLACE 迁移前提）', () => {
  it('WorkStep 前 9 位是既有顺序，新值只能出现在末尾', () => {
    const prefix = EXPECTED.WorkStep!;
    const actual = [...DB_ENUMS.WorkStep.values];
    expect(actual.slice(0, prefix.length)).toEqual(prefix);
  });
});