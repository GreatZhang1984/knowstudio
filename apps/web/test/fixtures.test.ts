import { describe, expect, it } from 'vitest';
import {
  GateId,
  RelativePath,
  WorkEnvelopeSchema,
  WorkListItem as WorkListItemSchema,
} from '@knowstudio/contracts';
import { FIXTURE_QUOTA, FIXTURE_RECENT, FIXTURE_WORKS } from '../src/work/fixtures';

/**
 * 占位数据也要被门禁看着：契约收紧过一次 redirectTo（空串不再合法），
 * 当时只有浏览器验证暴露了问题，pnpm test 全绿。这组用例补上那个缺口。
 */
const ENVELOPES = [...FIXTURE_WORKS.values()];

describe('dev 占位信封与契约一致', () => {
  it('三份信封都能过 WorkEnvelopeSchema', () => {
    expect(ENVELOPES).toHaveLength(3);
    for (const w of ENVELOPES) expect(WorkEnvelopeSchema.parse(w)).toEqual(w);
  });

  it('最近活跃作品能过 WorkListItem', () => {
    expect(WorkListItemSchema.parse(FIXTURE_RECENT)).toEqual(FIXTURE_RECENT);
  });

  it('parallelHint.redirectTo 是站内相对路径，禁用态也不例外', () => {
    for (const w of ENVELOPES) {
      expect(RelativePath.parse(w.parallelHint.redirectTo)).toBe(w.parallelHint.redirectTo);
    }
  });

  it('gateDetails 只装未满足的门（架构 §5.6）', () => {
    for (const w of ENVELOPES) {
      for (const gate of GateId.values) {
        const detail = w.gateDetails[gate];
        if (detail == null) continue;
        expect(detail.satisfied, `${w.id} 的 ${gate} 已满足却仍下发详情`).toBe(false);
        expect(w.gates[gate], `${w.id} 的 ${gate} 布尔与详情不一致`).toBe(false);
        expect(RelativePath.parse(detail.redirectTo)).toBe(detail.redirectTo);
      }
    }
  });

  it('每个未满足的门都有详情，深链锁定态才可演示', () => {
    for (const w of ENVELOPES) {
      for (const gate of GateId.values) {
        if (w.gates[gate]) expect(w.gateDetails[gate]).toBeUndefined();
        else expect(w.gateDetails[gate], `${w.id} 缺 ${gate} 详情`).toBeDefined();
      }
    }
  });

  it('额度三处同源：quota fixture 与最近活跃作品信封一致（AC-H3）', () => {
    const recent = FIXTURE_WORKS.get(FIXTURE_RECENT.id);
    expect(recent).toBeDefined();
    expect(FIXTURE_QUOTA).toEqual(recent?.quota);
    expect(FIXTURE_RECENT.step).toBe(recent?.step);
    expect(FIXTURE_RECENT.gates).toEqual(recent?.gates);
    expect(FIXTURE_RECENT.progress).toBe(recent?.progress);
  });
});