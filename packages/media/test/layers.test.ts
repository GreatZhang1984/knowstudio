import { describe, expect, it } from 'vitest';
import type { Script } from '@knowstudio/contracts';
import { buildLayerPlan, fingerprint, timelineOf } from '../src/index';

const script: Script = {
  id: 'sc_test',
  workId: 'w_test',
  version: 3,
  status: 'confirmed',
  confirmedAt: '2026-11-16T00:00:00.000Z',
  estimatedDuration: 2,
  actualDuration: null,
  sections: [
    {
      id: 'ss_1',
      kind: 'hook3s',
      ord: 0,
      rangeStart: null,
      rangeEnd: null,
      lines: [
        {
          id: 'sl_1',
          sectionId: 'ss_1',
          ord: 0,
          text: '第一句',
          editedByUser: false,
          charCount: 3,
        },
      ],
    },
  ],
};

describe('T-35 分层资产', () => {
  it('时间轴按 4.2 字/秒估算，最短 1.2 秒', () => {
    expect(timelineOf(script)[0]?.startMs).toBe(0);
    expect(timelineOf(script)[0]?.endMs).toBe(1200);
  });

  it('生成 slides/subtitles/timeline 三层，输入指纹稳定且内容不同', () => {
    const input = { templateId: 'tpl', voiceId: 'voice', speed: 1, orient: 'vertical' as const };
    const plan = buildLayerPlan(script, input);
    expect(plan.map((layer) => layer.kind)).toEqual(['slides', 'subtitles', 'timeline']);
    expect(new Set(plan.map((layer) => layer.contentHash)).size).toBe(3);
    expect(plan[0]?.inputFingerprint).toBe(fingerprint({ scriptVersion: 3, ...input }));
  });
});
