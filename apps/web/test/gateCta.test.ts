import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as UiModule from '@knowstudio/ui';
import type { GateLockedProps } from '@knowstudio/ui';
import { WorkEnvelopeSchema } from '@knowstudio/contracts';
import type { WorkEnvelope } from '@knowstudio/contracts';
import { workKeys } from '../src/work/queries';
import { WorkGate } from '../src/work/WorkGate';

/**
 * CTA 落地页的逐字断言。
 *
 * GateLocked 在拿到 onNavigate 时渲染的是 button（onClick 导航）而不是 a[href]，
 * 所以 SSR 的 HTML 里看不到落地页。这里把 GateLocked 换成记录 props 的探针，
 * 直接断言 WorkGate 交给它的 redirectTo / detail 就是服务端信封里的那一份。
 * 真实点击后的 URL 落点由浏览器实测覆盖。
 */
const captured = vi.hoisted(() => ({ props: [] as Record<string, unknown>[] }));

vi.mock('@knowstudio/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof UiModule>();
  return {
    ...actual,
    GateLocked: (props: GateLockedProps) => {
      captured.props.push({ ...props });
      return h('div', { 'data-cta': props.redirectTo }, 'locked');
    },
  };
});

function envelopeWith(redirectTo: string): WorkEnvelope {
  return WorkEnvelopeSchema.parse({
    id: 'w9',
    title: '探针作品',
    keyword: '探针',
    phase: 1,
    step: 'script',
    progress: 50,
    gates: { G1: true, G2: false, G3: false, G4: false },
    // 契约现在要求「未满足的门必须有详情」，缺详情会被前端读成已满足。
    // 本组只断言 G2，G3/G4 补齐是为了让信封本身合法，不参与断言。
    gateDetails: {
      G2: { satisfied: false, reason: 'SCRIPT_NOT_CONFIRMED', redirectTo },
      G3: {
        satisfied: false,
        reason: 'HD_RENDER_NOT_SUCCEEDED',
        redirectTo: '/studio/w9/render',
      },
      G4: {
        satisfied: false,
        reason: 'COMPLIANCE_REPORT_MISSING',
        redirectTo: '/publish/w9',
      },
    },
    selectedTopicId: 't01',
    scriptConfirmedAt: null,
    activeRenderJobId: null,
    parallelHint: { enabled: false, cta: '', redirectTo: '/studio/w9/script' },
    quota: { total: 60, used: 1, reserved: 0, left: 59, resetAt: '2026-12-01T00:00:00Z' },
  });
}

function renderGate(envelope: WorkEnvelope, gate: 'G2' | 'G4'): string {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false, gcTime: Infinity } },
  });
  qc.setQueryData(workKeys.envelope(envelope.id), envelope);
  return renderToStaticMarkup(
    h(
      QueryClientProvider,
      { client: qc },
      h(
        MemoryRouter,
        { initialEntries: [`/studio/${envelope.id}/video`] },
        h(
          Routes,
          null,
          h(Route, {
            path: '/studio/:id/video',
            element: h(WorkGate, { gate, children: h('div', null, 'page-video') }),
          }),
        ),
      ),
    ),
  );
}

beforeEach(() => {
  captured.props.length = 0;
});

describe('锁定态 CTA 的落地页一律来自服务端 redirectTo', () => {
  it('props.redirectTo 与 detail 逐字等于信封里的那一份', () => {
    const envelope = envelopeWith('/studio/w9/script');
    const html = renderGate(envelope, 'G2');
    expect(captured.props).toHaveLength(1);
    const props = captured.props[0] as unknown as GateLockedProps;
    expect(props.requiredGate).toBe('G2');
    expect(props.redirectTo).toBe(envelope.gateDetails.G2?.redirectTo);
    expect(props.detail).toEqual(envelope.gateDetails.G2);
    expect(props.onNavigate).toBeTypeOf('function');
    expect(html).toContain('data-cta="/studio/w9/script"');
    expect(html).not.toContain('page-video');
  });

  it('服务端换一个落地页，CTA 跟着换——前端没有硬编码的「上一门」', () => {
    for (const target of ['/studio/w9/script', '/discover/topics', '/works/w9']) {
      captured.props.length = 0;
      const html = renderGate(envelopeWith(target), 'G2');
      const props = captured.props[0] as unknown as GateLockedProps;
      expect(props.redirectTo, target).toBe(target);
      expect(html).toContain(`data-cta="${target}"`);
    }
  });

  it('requiredGate 与 detail 不匹配时仍以 detail 为准（不靠门 id 猜落地页）', () => {
    const envelope = envelopeWith('/works/w9');
    renderGate(envelope, 'G2');
    const props = captured.props[0] as unknown as GateLockedProps;
    expect(props.redirectTo).toBe('/works/w9');
    expect(props.redirectTo).not.toContain('/script');
  });
});