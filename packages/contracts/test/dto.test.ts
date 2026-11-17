import { describe, expect, it } from 'vitest';
import {
  ComplianceItemSchema,
  GateDetailsSchema,
  HttpUrl,
  ParallelHintSchema,
  QueryBoolean,
  QuotaSchema,
  RelativePath,
  UtcTimestamp,
  WorkEnvelopeSchema,
  WorkTruthSnapshotSchema,
} from '../src/dto.js';
import { GateNotSatisfied, ScriptLocked, Unauthenticated } from '../src/errors.js';
import { RenderAccepted } from '../src/api.js';

const RESET_AT = '2026-12-01T00:00:00Z';
const quota = (over: Partial<Record<'total' | 'used' | 'reserved' | 'left', number>> = {}) => ({
  total: 60,
  used: 22,
  reserved: 0,
  left: 38,
  resetAt: RESET_AT,
  ...over,
});

describe('配额恒等式（架构 §7.1，消灭 D-22）', () => {
  it('SPEC §4.3 种子 60/22/0/38 通过', () => {
    expect(QuotaSchema.parse(quota())).toEqual(quota());
  });

  it('预扣中：reserved=2 时 left 必须同步减 2', () => {
    expect(QuotaSchema.parse(quota({ reserved: 2, left: 36 })).left).toBe(36);
    expect(QuotaSchema.safeParse(quota({ reserved: 2, left: 38 })).success).toBe(false);
  });

  it('left 算错一律拒绝，而不是等到 UI 三处数字不一致', () => {
    for (const left of [0, 37, 39, 60, -1]) {
      expect(QuotaSchema.safeParse(quota({ left })).success).toBe(false);
    }
  });

  it('超支 used+reserved>total 物理不可能', () => {
    expect(QuotaSchema.safeParse(quota({ used: 60, reserved: 1, left: -1 })).success).toBe(false);
    expect(QuotaSchema.safeParse(quota({ used: 61, reserved: 0, left: -1 })).success).toBe(false);
  });

  it('边界：恰好用满合法', () => {
    expect(QuotaSchema.parse(quota({ used: 58, reserved: 2, left: 0 })).left).toBe(0);
  });

  it('拒绝浮点点数（架构 §4.2 禁止浮点）', () => {
    expect(QuotaSchema.safeParse(quota({ used: 22.5, left: 37.5 })).success).toBe(false);
  });

  it('拒绝负数 total/used/reserved', () => {
    expect(QuotaSchema.safeParse(quota({ total: -1, left: 39 })).success).toBe(false);
    expect(QuotaSchema.safeParse(quota({ reserved: -2, left: 40 })).success).toBe(false);
  });
});

describe('QueryBoolean 不被 "false" 骗到', () => {
  it('字面量 true/false 正确解析', () => {
    expect(QueryBoolean.parse('true')).toBe(true);
    expect(QueryBoolean.parse('false')).toBe(false);
  });

  it('拒绝 z.coerce.boolean() 会误判为 true 的输入', () => {
    for (const v of ['0', '1', 'yes', 'no', '', 'True']) {
      expect(QueryBoolean.safeParse(v).success).toBe(false);
    }
    expect(QueryBoolean.safeParse(false).success).toBe(false);
  });
});

describe('合规报告项（架构 §4.3 JSON 值域由 zod 约束）', () => {
  const item = {
    kind: 'image',
    status: 'block',
    detail: '素材 mat_3 授权未知',
    blocking: true,
    materialIds: ['mat_3'],
    fixHint: '替换为已授权素材或上传凭证',
  };

  it('合法项通过且 materialIds 缺省为空数组', () => {
    const parsed = ComplianceItemSchema.parse({ ...item, materialIds: undefined });
    expect(parsed.materialIds).toEqual([]);
  });

  it('kind/status 域外值被拒（MySQL 无法对 JSON 内部做 ENUM 校验）', () => {
    expect(ComplianceItemSchema.safeParse({ ...item, kind: 'video' }).success).toBe(false);
    expect(ComplianceItemSchema.safeParse({ ...item, status: 'ok' }).success).toBe(false);
  });

  it('可定位到文案行（content 类搬运检测）', () => {
    expect(ComplianceItemSchema.parse({ ...item, kind: 'content', lineId: 'line_7' }).lineId).toBe('line_7');
  });
});

describe('WorkTruthSnapshot 是闸门派生的唯一输入', () => {
  const base = {
    workId: 'w_1',
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

  it('新建 Work 的空快照合法', () => {
    expect(WorkTruthSnapshotSchema.parse(base).workId).toBe('w_1');
  });

  it('指纹必须是 64 位 sha256 十六进制长度', () => {
    const snap = {
      ...base,
      latestCompliance: { blockingCount: 0, fingerprint: 'a'.repeat(64) },
    };
    expect(WorkTruthSnapshotSchema.parse(snap).latestCompliance?.fingerprint).toHaveLength(64);
    expect(
      WorkTruthSnapshotSchema.safeParse({
        ...base,
        latestCompliance: { blockingCount: 0, fingerprint: 'short' },
      }).success,
    ).toBe(false);
  });

  it('派生平台 id 受枚举约束', () => {
    expect(
      WorkTruthSnapshotSchema.safeParse({
        ...base,
        derivatives: [{ platformId: 'weibo', ruleVersion: 1, title: 't', tags: [] }],
      }).success,
    ).toBe(false);
  });
});

describe('统一信封（AC-H3 三处额度同源）', () => {
  /**
   * 转录架构 §5.6 示例（arch:1231-1244），但**补齐了原示例漏掉的 G4 详情**。
   *
   * 原示例 gates 为 {G1:true,G2:true,G3:false,G4:false}（arch:1234），
   * 而 gateDetails 只给了 G3（arch:1235-1238）——G4=false 却无详情，
   * 违反 §5.6 自己声明的「只装未满足的门」规则，正是 fail-open 的漂移形状。
   * 规则赢、示例错：不变量 gates[g]=false ⟺ 详情存在且 satisfied=false 成立。
   *
   * 旁证：前端作者已独立发现同一处遗漏并补齐——apps/web/src/work/fixtures.ts:19
   * 的 gates 与示例逐字相同，但 :20-32 的 gateDetails 同时含 G3 与 G4，
   * G4 为 {satisfied:false, reason:'COMPLIANCE_REPORT_MISSING', redirectTo:'/publish/w1'}。
   * G4 的 redirectTo 是派生页而非 export 自身：export 页正是 G4 的锁定对象，
   * 指向自身会让「回到上一门」原地死循环（客户 2026-11-13 拍板选项 3，SPEC §2.3 derive ──G4──> export）。
   * 本处按同一形状补 G4（id 沿用本测试的 w_1）。
   *
   * 这是修正转录数据，不是放宽断言：下面 parse 成功与 G3.reason 的断言一字未动。
   * arch 示例本身需补一行，归架构 owner（见 review/t05-envelope-gate-consistency.md）。
   */
  const envelope = {
    id: 'w_1',
    title: '作品',
    keyword: '复利',
    phase: 2,
    step: 'video.rendering',
    progress: 70,
    gates: { G1: true, G2: true, G3: false, G4: false },
    gateDetails: {
      G3: {
        satisfied: false,
        reason: 'HD_RENDER_NOT_SUCCEEDED',
        redirectTo: '/studio/w_1/render',
        activeJobId: 'job_88',
      },
      G4: {
        satisfied: false,
        reason: 'COMPLIANCE_REPORT_MISSING',
        redirectTo: '/publish/w_1',
      },
    },
    selectedTopicId: 'topic_1',
    scriptConfirmedAt: '2026-11-12T10:00:00Z',
    activeRenderJobId: 'job_88',
    parallelHint: { enabled: true, cta: '渲染时你可以先去写平台标题', redirectTo: '/publish/w_1' },
    quota: quota({ reserved: 2, left: 36 }),
  };

  it('架构 §5.6 示例信封可解析', () => {
    const parsed = WorkEnvelopeSchema.parse(envelope);
    expect(parsed.gateDetails.G3?.reason).toBe('HD_RENDER_NOT_SUCCEEDED');
    expect(parsed.parallelHint.enabled).toBe(true);
  });

  it('progress 越界被拒', () => {
    expect(WorkEnvelopeSchema.safeParse({ ...envelope, progress: 101 }).success).toBe(false);
    expect(WorkEnvelopeSchema.safeParse({ ...envelope, progress: -1 }).success).toBe(false);
  });

  it('gateDetails 的 reason 必须是已登记原因码', () => {
    expect(
      GateDetailsSchema.safeParse({
        G3: { satisfied: false, reason: 'WHATEVER', redirectTo: '/x' },
      }).success,
    ).toBe(false);
  });

  it('G5 不出现在 gates 中', () => {
    expect(Object.keys(WorkEnvelopeSchema.parse(envelope).gates)).toEqual(['G1', 'G2', 'G3', 'G4']);
  });
});

describe('RelativePath：深链回跳不得成为开放重定向面（P1-9）', () => {
  it('站内路径放行', () => {
    for (const p of ['/studio/w_1/script', '/publish/w_1', '/discover/topics?batch=2', '/']) {
      expect(RelativePath.safeParse(p).success, p).toBe(true);
    }
  });

  it('协议相对 URL 与反斜杠变体被拒（浏览器会把它们当外站）', () => {
    for (const p of ['//evil.com', '/\\evil.com', '///evil.com', 'https://evil.com', 'http://evil.com']) {
      expect(RelativePath.safeParse(p).success, p).toBe(false);
    }
  });

  it('可执行协议、无首斜杠、空串、超长一律被拒', () => {
    for (const p of ['javascript:alert(1)', 'data:text/html,x', 'studio/w_1', '', `/${'a'.repeat(2048)}`]) {
      expect(RelativePath.safeParse(p).success, JSON.stringify(p.slice(0, 32))).toBe(false);
    }
  });

  it('服务端下发的四个回跳字段都用同一把尺子', () => {
    const renderAccepted = {
      jobId: 'job_88',
      costPoints: 2,
      reservationId: 'rsv_12',
      quota: quota({ reserved: 2, left: 36 }),
    };
    for (const url of ['//evil.com', 'https://evil.com', 'javascript:alert(1)']) {
      expect(
        GateNotSatisfied.safeParse({
          code: 'GATE_NOT_SATISFIED',
          message: 'x',
          details: { requiredGate: 'G3', redirectTo: url, reason: 'HD_RENDER_NOT_SUCCEEDED' },
        }).success,
        url,
      ).toBe(false);
      expect(
        Unauthenticated.safeParse({ code: 'UNAUTHENTICATED', message: 'x', details: { loginUrl: url } }).success,
        url,
      ).toBe(false);
      expect(
        ScriptLocked.safeParse({ code: 'SCRIPT_LOCKED', message: 'x', details: { unlockUrl: url } }).success,
        url,
      ).toBe(false);
      expect(RenderAccepted.safeParse({ ...renderAccepted, sseUrl: url }).success, url).toBe(false);
    }
  });
});

describe('HttpUrl：外部素材链接只允许 http/https（P1-4）', () => {
  it('http/https 放行', () => {
    expect(HttpUrl.safeParse('https://example.com/a.png').success).toBe(true);
    expect(HttpUrl.safeParse('http://example.com/a.png').success).toBe(true);
  });

  it('可执行与本地协议被拒', () => {
    const bad = [
      'javascript:alert(1)',
      'data:image/png;base64,AAAA',
      'file:///etc/passwd',
      'ftp://example.com/a',
      'blob:https://example.com/x',
      'not a url',
    ];
    for (const u of bad) expect(HttpUrl.safeParse(u).success, u).toBe(false);
  });

  it('畸形 URL 返回 false 而不是抛异常（zod 在 dirty 值上仍执行 refine）', () => {
    for (const u of ['not a url', '', 'http://', 'https://', '://x']) {
      expect(() => HttpUrl.safeParse(u), u).not.toThrow();
      expect(HttpUrl.safeParse(u).success, u).toBe(false);
    }
  });
});

describe('UtcTimestamp：只收 Z，不收 ±HH:MM（P1-3 指纹确定性）', () => {
  it('同一时刻的偏移写法被拒，避免素材未改却算出不同合规指纹', () => {
    expect(UtcTimestamp.safeParse('2026-11-12T10:00:00Z').success).toBe(true);
    expect(UtcTimestamp.safeParse('2026-11-12T18:00:00+08:00').success).toBe(false);
    expect(UtcTimestamp.safeParse('2026-11-12T10:00:00').success).toBe(false);
  });
});

describe('ParallelHint：禁用态没有落地页，启用态必须有（D-07）', () => {
  it('禁用态空串放行——空串不是重定向', () => {
    expect(ParallelHintSchema.safeParse({ enabled: false, cta: '', redirectTo: '' }).success).toBe(true);
  });

  it('启用态空串被拒：给了 CTA 却不给去处，前端点了没反应', () => {
    expect(ParallelHintSchema.safeParse({ enabled: true, cta: '去写标题', redirectTo: '' }).success).toBe(false);
  });

  it('启用态的外站落地页被拒', () => {
    expect(ParallelHintSchema.safeParse({ enabled: true, cta: '去写标题', redirectTo: '//evil.com' }).success).toBe(false);
  });

  it('禁用态带站内路径也放行（前端可预取，不构成开放重定向）', () => {
    expect(ParallelHintSchema.safeParse({ enabled: false, cta: '', redirectTo: '/studio/w_1/script' }).success).toBe(true);
  });
});