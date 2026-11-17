// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserObservability } from '../src/browser.js';

describe('T-59 前端埋点 SDK', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('满 20 条立即批量上报，并携带 Bearer 凭证', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = createBrowserObservability({
      getAuthorization: () => 'token-1',
      flushSize: 2,
    });

    client.track({ event: 'script_first_edit', workId: 'w_1', props: { editDistanceRatio: 0.1 } });
    client.track({
      event: 'publish_receipt_marked',
      workId: 'w_1',
      props: { platformId: 'douyin' },
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer token-1');
    expect(JSON.parse(String(init.body))).toEqual({
      events: [
        {
          event: 'script_first_edit',
          workId: 'w_1',
          props: { editDistanceRatio: 0.1 },
          occurredAt: expect.stringMatching(/^2\d{3}-/u),
        },
        {
          event: 'publish_receipt_marked',
          workId: 'w_1',
          props: { platformId: 'douyin' },
          occurredAt: expect.stringMatching(/^2\d{3}-/u),
        },
      ],
    });
    client.dispose();
  });

  it('页面关闭时用 sendBeacon 兜底', () => {
    const beacon = vi.fn().mockReturnValue(true);
    vi.stubGlobal('navigator', { sendBeacon: beacon });
    const client = createBrowserObservability({ flushSize: 20 });

    client.track({ event: 'script_first_edit', workId: 'w_1', props: {} });
    window.dispatchEvent(new Event('pagehide'));

    expect(beacon).toHaveBeenCalledWith('/api/events', expect.any(Blob));
    client.dispose();
  });

  it('上报失败后等待下一轮定时重试，不同步递归', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);
    const client = createBrowserObservability({
      flushIntervalMs: 60_000,
      flushSize: 2,
    });

    client.track({ event: 'publish_receipt_marked', workId: 'w_1', props: {} });
    await client.flush();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    client.dispose();
  });
});
