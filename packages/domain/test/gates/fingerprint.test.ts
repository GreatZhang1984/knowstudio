import { describe, expect, it } from 'vitest';
import type { WorkTruthSnapshot } from '@knowstudio/contracts';
import { complianceFingerprint, deriveGates } from '../../src/index.js';
import { SCRIPT_VERSION, allSatisfied, deepFreeze, truth, withReport } from '../fixtures.js';

/**
 * 期望依据架构 §8.4「报告指纹与 G4 防陈旧放行」（architecture/knowledge-video-tool.md:1697-1707）：
 *   sha256( sorted[(materialId, license, licenseEvidenceVersion)]
 *         + scriptVersion + scriptContentHash
 *         + sorted[(platformId, ruleVersion, title, tags)]
 *         + templateId@version + fontFamily
 *         + bgmTrackId + evidenceExpiresAt
 *         + lexiconVersion )
 * 以及架构 §5.2 表 G4 行「失效触发：素材增删/授权变更/文案变更/规则版本变更/模板字体变更」（arch:1155）。
 * 文档给出的是指纹的**组成与性质**，未给任何字面哈希值，因此本文件断言的是
 * 「sha256 形状 / 同一真相同一指纹 / 排序无关 / 七组输入逐项敏感 / 清单外字段不参与」，
 * 不写死任何 64 位常量，也不复用被测实现去算期望值。
 */
const BASE = truth();
const HEX64 = /^[0-9a-f]{64}$/;

type Mutation = { name: string; trigger: string; over: Partial<WorkTruthSnapshot> };

/** 每一条都对应架构 §8.4 的一个指纹输入字段，或 §5.2 G4 行的一个失效触发。 */
const MUTATIONS: readonly Mutation[] = [
  {
    name: '新增引用素材 k3（需授权）',
    trigger: '素材增删',
    over: {
      materials: [...BASE.materials, { materialId: 'k3', license: 'restricted', licenseEvidenceVersion: 1 }],
    },
  },
  { name: '移除一条引用素材', trigger: '素材增删', over: { materials: [BASE.materials[0]!] } },
  {
    name: '素材授权 cleared → restricted',
    trigger: '授权变更',
    over: { materials: [{ ...BASE.materials[0]!, license: 'restricted' }, BASE.materials[1]!] },
  },
  {
    name: '素材授权 cleared → unknown（SPEC §8.1 按 restricted 处理）',
    trigger: '授权变更',
    over: { materials: [{ ...BASE.materials[0]!, license: 'unknown' }, BASE.materials[1]!] },
  },
  {
    name: '素材授权凭证版本 +1',
    trigger: '授权变更',
    over: {
      materials: [{ ...BASE.materials[0]!, licenseEvidenceVersion: 2 }, BASE.materials[1]!],
    },
  },
  {
    name: '换了一条素材（materialId 变化）',
    trigger: '素材增删',
    over: { materials: [{ ...BASE.materials[0]!, materialId: 'k2' }, BASE.materials[1]!] },
  },
  {
    name: '文案版本 +1',
    trigger: '文案变更',
    over: { script: { ...BASE.script!, version: SCRIPT_VERSION + 1 } },
  },
  {
    name: '文案内容哈希变化（同版本改字）',
    trigger: '文案变更',
    over: { script: { ...BASE.script!, contentHash: 'hash-v3-edited' } },
  },
  {
    name: '新增一个平台的派生',
    trigger: '规则版本变更',
    over: {
      derivatives: [
        ...BASE.derivatives,
        { platformId: 'xhs', ruleVersion: 3, title: '费曼学习法', tags: ['学习'] },
      ],
    },
  },
  { name: '删除一个平台的派生', trigger: '规则版本变更', over: { derivatives: [BASE.derivatives[0]!] } },
  {
    name: '平台规则版本 +1',
    trigger: '规则版本变更',
    over: { derivatives: [{ ...BASE.derivatives[0]!, ruleVersion: 4 }, BASE.derivatives[1]!] },
  },
  {
    name: '平台标题改写',
    trigger: '规则版本变更',
    over: { derivatives: [{ ...BASE.derivatives[0]!, title: '为什么你学了就忘' }, BASE.derivatives[1]!] },
  },
  {
    name: '平台标签新增一个',
    trigger: '规则版本变更',
    over: {
      derivatives: [
        { ...BASE.derivatives[0]!, tags: [...BASE.derivatives[0]!.tags, '记忆'] },
        BASE.derivatives[1]!,
      ],
    },
  },
  {
    name: '平台标签删除一个',
    trigger: '规则版本变更',
    over: { derivatives: [{ ...BASE.derivatives[0]!, tags: ['学习方法'] }, BASE.derivatives[1]!] },
  },
  {
    name: '平台标签内容改写',
    trigger: '规则版本变更',
    over: { derivatives: [{ ...BASE.derivatives[0]!, tags: ['费曼技巧', '费曼'] }, BASE.derivatives[1]!] },
  },
  {
    name: '换模板（templateId 变化）',
    trigger: '模板字体变更',
    over: { template: { ...BASE.template!, templateId: 'tpl2' } },
  },
  {
    name: '模板版本 +1',
    trigger: '模板字体变更',
    over: { template: { ...BASE.template!, version: 3 } },
  },
  {
    name: '字体 family 变更（思源黑体 → Noto Sans SC）',
    trigger: '模板字体变更',
    over: { template: { ...BASE.template!, fontFamily: 'Noto Sans SC' } },
  },
  { name: '换 BGM 曲目', trigger: '音乐授权变更', over: { bgm: { ...BASE.bgm!, trackId: 'bgm2' } } },
  {
    name: 'BGM 授权凭证到期时间变化',
    trigger: '音乐授权变更',
    over: { bgm: { ...BASE.bgm!, evidenceExpiresAt: '2027-06-01T00:00:00Z' } },
  },
  { name: '移除 BGM', trigger: '音乐授权变更', over: { bgm: null } },
  { name: '移除模板', trigger: '模板字体变更', over: { template: null } },
  { name: '删除文案', trigger: '文案变更', over: { script: null } },
  { name: '敏感词库版本 +1', trigger: '词库版本变更', over: { lexiconVersion: 8 } },
];

/** 架构 §8.4 的清单是穷尽的：清单外的真相字段不参与指纹。 */
const NON_INPUTS: readonly { name: string; over: Partial<WorkTruthSnapshot> }[] = [
  { name: 'workId 换成 w2', over: { workId: 'w2' } },
  { name: '重新选题', over: { selectedTopicId: 't05' } },
  { name: '取消选题', over: { selectedTopicId: null } },
  {
    name: '高清资产状态变化',
    over: { latestHdAsset: { id: 'va1', status: 'running', stale: false, scriptVersion: SCRIPT_VERSION } },
  },
  {
    name: '高清资产被标记 stale',
    over: { latestHdAsset: { id: 'va1', status: 'succeeded', stale: true, scriptVersion: SCRIPT_VERSION } },
  },
  { name: '高清资产被删除', over: { latestHdAsset: null } },
  {
    name: '合规报告自身（blockingCount 与 fingerprint）',
    over: { latestCompliance: { blockingCount: 9, fingerprint: '0'.repeat(64) } },
  },
  { name: '合规报告被删除', over: { latestCompliance: null } },
  { name: '文案 id 变化', over: { script: { ...BASE.script!, id: 'sc2' } } },
  { name: '文案状态变化', over: { script: { ...BASE.script!, status: 'draft' } } },
  { name: '文案确认时间变化', over: { script: { ...BASE.script!, confirmedAt: null } } },
];

describe('指纹形状与确定性（架构 §8.4：sha256）', () => {
  it('是 64 位小写十六进制（sha256 / 契约 ComplianceReportSchema.fingerprint）', () => {
    const fp = complianceFingerprint(BASE);
    expect(fp).toHaveLength(64);
    expect(fp).toMatch(HEX64);
  });

  it('同一真相多次计算结果相同', () => {
    expect(complianceFingerprint(BASE)).toBe(complianceFingerprint(BASE));
  });

  it('内容相同的另一个对象得到同一指纹（与对象身份无关）', () => {
    const clone = JSON.parse(JSON.stringify(BASE)) as WorkTruthSnapshot;
    expect(complianceFingerprint(clone)).toBe(complianceFingerprint(BASE));
  });

  it('快照字段的书写顺序不影响指纹（规范化后再哈希）', () => {
    const reordered: WorkTruthSnapshot = {
      lexiconVersion: BASE.lexiconVersion,
      bgm: BASE.bgm,
      template: BASE.template,
      derivatives: BASE.derivatives,
      materials: BASE.materials,
      latestCompliance: BASE.latestCompliance,
      latestHdAsset: BASE.latestHdAsset,
      script: BASE.script,
      selectedTopicId: BASE.selectedTopicId,
      workId: BASE.workId,
    };
    expect(complianceFingerprint(reordered)).toBe(complianceFingerprint(BASE));
  });

  it('空真相也有确定指纹（全新 Work，架构 §5.1）', () => {
    const empty: WorkTruthSnapshot = {
      workId: 'w1',
      selectedTopicId: null,
      script: null,
      latestHdAsset: null,
      latestCompliance: null,
      materials: [],
      derivatives: [],
      template: null,
      bgm: null,
      lexiconVersion: 1,
    };
    expect(complianceFingerprint(empty)).toMatch(HEX64);
    expect(complianceFingerprint(empty)).toBe(complianceFingerprint({ ...empty }));
  });
});

describe('排序无关（架构 §8.4：sorted[...]，同一真相不得因查询顺序得到两个指纹）', () => {
  const three = [
    { materialId: 'k1', license: 'cleared', licenseEvidenceVersion: 1 },
    { materialId: 'k3', license: 'restricted', licenseEvidenceVersion: 2 },
    { materialId: 'k4', license: 'unknown', licenseEvidenceVersion: 0 },
  ] as const;

  const permutations = <T,>(items: readonly T[]): T[][] =>
    items.length <= 1
      ? [[...items]]
      : items.flatMap((item, i) =>
          permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
        );

  it('引用素材的 6 种排列得到同一指纹', () => {
    const fps = permutations(three).map((materials) =>
      complianceFingerprint(truth({ materials: materials.map((m) => ({ ...m })) })),
    );
    expect(fps).toHaveLength(6);
    expect(new Set(fps).size).toBe(1);
  });

  it('派生平台的 6 种排列得到同一指纹', () => {
    const platforms = [
      { platformId: 'douyin', ruleVersion: 3, title: '抖音标题', tags: ['a'] },
      { platformId: 'bili', ruleVersion: 3, title: 'B站标题', tags: ['b'] },
      { platformId: 'xhs', ruleVersion: 4, title: '小红书标题', tags: ['c'] },
    ] as const;
    const fps = permutations(platforms).map((derivatives) =>
      complianceFingerprint(truth({ derivatives: derivatives.map((d) => ({ ...d, tags: [...d.tags] })) })),
    );
    expect(fps).toHaveLength(6);
    expect(new Set(fps).size).toBe(1);
  });

  it('素材与派生同时乱序仍得到同一指纹', () => {
    const a = complianceFingerprint(BASE);
    const b = complianceFingerprint(
      truth({ materials: [...BASE.materials].reverse(), derivatives: [...BASE.derivatives].reverse() }),
    );
    expect(b).toBe(a);
  });
});

describe('七组输入逐项敏感（架构 §8.4 组成 + §5.2 G4 失效触发）', () => {
  for (const m of MUTATIONS) {
    it(`${m.name}（${m.trigger}）→ 指纹变化`, () => {
      expect(complianceFingerprint({ ...BASE, ...m.over })).not.toBe(complianceFingerprint(BASE));
    });

    it(`${m.name} → 旧报告不得放行导出（G4 失效）`, () => {
      const reported = withReport(BASE);
      expect(deriveGates(reported).G4).toBe(true);
      const changed: WorkTruthSnapshot = { ...reported, ...m.over };
      expect(deriveGates(changed).G4).toBe(false);
    });
  }

  it(`${MUTATIONS.length} 项变更各自产生互不相同的指纹（无碰撞）`, () => {
    const fps = MUTATIONS.map((m) => complianceFingerprint({ ...BASE, ...m.over }));
    expect(fps).toHaveLength(MUTATIONS.length);
    expect(new Set(fps).size).toBe(MUTATIONS.length);
    expect(fps).not.toContain(complianceFingerprint(BASE));
  });

  it('中文标题与标签按 UTF-8 参与哈希：改一个汉字即变化', () => {
    const a = complianceFingerprint(BASE);
    const b = complianceFingerprint(
      truth({
        derivatives: [{ ...BASE.derivatives[0]!, title: '费曼学习法：为什么你学了就忘了' }, BASE.derivatives[1]!],
      }),
    );
    expect(b).not.toBe(a);
    expect(b).toMatch(HEX64);
  });
});

describe('「没有」与「空」不碰撞（架构 §8.4：授权态必须可区分）', () => {
  it('无 BGM ≠ 有 BGM', () => {
    expect(complianceFingerprint(truth({ bgm: null }))).not.toBe(complianceFingerprint(BASE));
  });

  it('BGM 凭证到期时间为 null ≠ 有到期时间', () => {
    expect(complianceFingerprint(truth({ bgm: { ...BASE.bgm!, evidenceExpiresAt: null } }))).not.toBe(
      complianceFingerprint(BASE),
    );
  });

  it('无模板 ≠ 有模板', () => {
    expect(complianceFingerprint(truth({ template: null }))).not.toBe(complianceFingerprint(BASE));
  });

  it('字体为空串 ≠ 思源黑体', () => {
    expect(complianceFingerprint(truth({ template: { ...BASE.template!, fontFamily: '' } }))).not.toBe(
      complianceFingerprint(BASE),
    );
  });

  it('无文案 ≠ 有文案', () => {
    expect(complianceFingerprint(truth({ script: null }))).not.toBe(complianceFingerprint(BASE));
  });

  it('文案 contentHash 为空串 ≠ 有哈希', () => {
    expect(complianceFingerprint(truth({ script: { ...BASE.script!, contentHash: '' } }))).not.toBe(
      complianceFingerprint(BASE),
    );
  });

  it('无引用素材 ≠ 有一条素材', () => {
    expect(complianceFingerprint(truth({ materials: [] }))).not.toBe(complianceFingerprint(BASE));
  });

  it('无派生 ≠ 有一个平台派生', () => {
    expect(complianceFingerprint(truth({ derivatives: [] }))).not.toBe(complianceFingerprint(BASE));
  });

  it('模板 id@version 的组合参与哈希：id 与 version 互换不得碰撞', () => {
    const a = complianceFingerprint(truth({ template: { templateId: 'tpl1', version: 2, fontFamily: '思源黑体' } }));
    const b = complianceFingerprint(truth({ template: { templateId: 'tpl2', version: 1, fontFamily: '思源黑体' } }));
    expect(a).not.toBe(b);
  });
});

describe('清单外字段不参与指纹（架构 §8.4 的组成是穷尽清单）', () => {
  for (const n of NON_INPUTS) {
    it(`${n.name} → 指纹不变`, () => {
      expect(complianceFingerprint({ ...BASE, ...n.over })).toBe(complianceFingerprint(BASE));
    });
  }

  it('报告自身不参与指纹，否则会自指而永远无法判定陈旧', () => {
    const reported = withReport(BASE);
    expect(complianceFingerprint(reported)).toBe(complianceFingerprint(BASE));
    expect(complianceFingerprint(withReport(BASE, 5))).toBe(complianceFingerprint(BASE));
  });
});

describe('纯函数性（架构 §3.2：domain 零 IO，前后端共用）', () => {
  it('不就地排序快照数组（排序必须在拷贝上做）', () => {
    const s = truth({
      materials: [
        { materialId: 'k4', license: 'cleared', licenseEvidenceVersion: 1 },
        { materialId: 'k1', license: 'cleared', licenseEvidenceVersion: 1 },
      ],
      derivatives: [BASE.derivatives[1]!, BASE.derivatives[0]!],
    });
    const materialIds = s.materials.map((m) => m.materialId);
    const platformIds = s.derivatives.map((d) => d.platformId);
    complianceFingerprint(s);
    expect(s.materials.map((m) => m.materialId)).toEqual(materialIds);
    expect(s.derivatives.map((d) => d.platformId)).toEqual(platformIds);
  });

  it('快照被深冻结后仍可计算，且内容不变', () => {
    const s = deepFreeze(allSatisfied());
    const before = JSON.stringify(s);
    expect(complianceFingerprint(s)).toMatch(HEX64);
    expect(JSON.stringify(s)).toBe(before);
  });

  it('指纹与派生门互不污染：连续计算结果稳定', () => {
    const s = allSatisfied();
    const first = complianceFingerprint(s);
    deriveGates(s);
    expect(complianceFingerprint(s)).toBe(first);
  });
});