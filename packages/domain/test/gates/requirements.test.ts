import { describe, expect, it } from 'vitest';
import { DeriveScope, GateId } from '@knowstudio/contracts';
import { GATED_ACTIONS, requiredGate, type GateAction } from '../../src/index.js';

/**
 * 期望值逐行抄自架构 §5.3「服务端校验点」路由表
 * （spark-output/architecture/knowledge-video-tool.md:1189-1199），
 * 派生二分见架构 §5.4 表（arch:1205-1208）与 §10.3「缺省 media 保持 SPEC 兼容」（arch:1871），
 * 原始门标注见 SPEC §5 接口契约（spec:553-558）与 SPEC §2.3（spec:135-138）。
 * A1 已拍板把 G3 收窄到 media 派生动作（契约 DeriveScope 注释 / 架构 §5.4）。
 */
const DOC_ROUTE_GATES: readonly { action: GateAction; gate: GateId; doc: string }[] = [
  { action: 'script:generate', gate: 'G1', doc: 'POST /works/:id/script:generate → G1' },
  { action: 'video:draft', gate: 'G2', doc: 'POST /works/:id/video:draft → G2（0 点）' },
  { action: 'video:render', gate: 'G2', doc: 'POST /works/:id/video:render → G2 + 额度' },
  { action: 'video:patch', gate: 'G2', doc: 'POST /works/:id/video:patch → G2 + 增量额度' },
  { action: 'derivatives:patch', gate: 'G2', doc: 'PATCH /works/:id/derivatives/:platformId → G2' },
  { action: 'export', gate: 'G4', doc: 'POST /works/:id/export → G4（服务端重算合规）' },
];

const SCOPES: readonly (DeriveScope | undefined)[] = [undefined, 'metadata', 'media'];

describe('架构 §5.3 路由门标注逐行一致（T-12：门标注的权威来源）', () => {
  for (const { action, gate, doc } of DOC_ROUTE_GATES) {
    for (const scope of SCOPES) {
      it(`${action}${scope === undefined ? '（缺省 scope）' : ` scope=${scope}`} → ${gate}｜${doc}`, () => {
        expect(
          scope === undefined ? requiredGate(action) : requiredGate(action, scope),
        ).toBe(gate);
      });
    }
  }

  it('非派生动作不受 scope 影响（标题/标签随时可编辑，架构 §5.3）', () => {
    for (const { action, gate } of DOC_ROUTE_GATES) {
      expect(requiredGate(action, 'metadata')).toBe(gate);
      expect(requiredGate(action, 'media')).toBe(gate);
      expect(requiredGate(action)).toBe(gate);
    }
  });
});

describe('D-07 派生二分：metadata 只需 G2，media 需 G3（架构 §5.4）', () => {
  it('scope=metadata → G2（高清渲染排队时即可执行）', () => {
    expect(requiredGate('derivatives:generate', 'metadata')).toBe('G2');
  });

  it('scope=media → G3（渲染完成后才能拿母版成片派生）', () => {
    expect(requiredGate('derivatives:generate', 'media')).toBe('G3');
  });

  it('缺省 scope 按 media 处理，与 GenerateDerivativesRequest 默认值一致（架构 §10.3）', () => {
    expect(requiredGate('derivatives:generate')).toBe('G3');
    expect(requiredGate('derivatives:generate')).toBe(requiredGate('derivatives:generate', 'media'));
  });

  it('漏传 scope 时宁可多校验一道门，不可少校验（缺省不得落到 G2）', () => {
    expect(requiredGate('derivatives:generate')).not.toBe('G2');
  });

  it('两个 scope 都被契约接受，且只有这两个（A1 收窄）', () => {
    expect([...DeriveScope.values]).toEqual(['metadata', 'media']);
    for (const scope of DeriveScope.values) {
      expect(GateId.safeParse(requiredGate('derivatives:generate', scope)).success).toBe(true);
    }
  });
});

describe('GATED_ACTIONS 清单与值域', () => {
  it('恰好覆盖架构 §5.3 表中需要校验的 7 个写动作', () => {
    expect([...GATED_ACTIONS].sort()).toEqual(
      [
        'script:generate',
        'video:draft',
        'video:render',
        'video:patch',
        'derivatives:generate',
        'derivatives:patch',
        'export',
      ].sort(),
    );
    expect(GATED_ACTIONS).toHaveLength(7);
  });

  it('无重复项', () => {
    expect(new Set(GATED_ACTIONS).size).toBe(GATED_ACTIONS.length);
  });

  it('每个动作在两种 scope 下都有确定门标注，且落在 G1–G4', () => {
    for (const action of GATED_ACTIONS) {
      for (const scope of DeriveScope.values) {
        const gate = requiredGate(action, scope);
        expect(GateId.safeParse(gate).success).toBe(true);
        expect([...GateId.values]).toContain(gate);
      }
    }
  });

  it('永不返回 G5：系统不提供平台发布写接口（SPEC §2.3 / 架构 §5.5 静态防线）', () => {
    for (const action of GATED_ACTIONS) {
      for (const scope of DeriveScope.values) {
        expect(requiredGate(action, scope)).not.toBe('G5');
      }
    }
    expect(GATED_ACTIONS.join(' ')).not.toContain('publish');
  });

  it('门标注只用到 G1/G2/G3/G4 四门，且四门都被用到', () => {
    const used = new Set<string>();
    for (const action of GATED_ACTIONS) {
      for (const scope of DeriveScope.values) used.add(requiredGate(action, scope));
    }
    expect([...used].sort()).toEqual(['G1', 'G2', 'G3', 'G4']);
  });
});

describe('纯函数性（架构 §3.2：前端深链防护与 Guard 共用同一份标注）', () => {
  it('重复调用结果恒定，清单不被修改', () => {
    const before = [...GATED_ACTIONS];
    for (const action of GATED_ACTIONS) {
      expect(requiredGate(action, 'media')).toBe(requiredGate(action, 'media'));
    }
    expect([...GATED_ACTIONS]).toEqual(before);
  });
});