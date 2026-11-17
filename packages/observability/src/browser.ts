import type { AnalyticsEventName } from '@knowstudio/contracts';

type BrowserEventName = Extract<AnalyticsEventName, 'script_first_edit' | 'publish_receipt_marked'>;

export interface BrowserEventInput {
  readonly event: BrowserEventName;
  readonly workId: string;
  readonly props?: Record<string, unknown>;
}

interface QueuedEvent extends BrowserEventInput {
  readonly occurredAt: string;
}

export interface BrowserObservabilityOptions {
  readonly endpoint?: string;
  readonly getAuthorization?: () => string | null;
  readonly flushSize?: number;
  readonly flushIntervalMs?: number;
}

const DEFAULT_FLUSH_SIZE = 20;
const DEFAULT_FLUSH_INTERVAL_MS = 5_000;

/** 前端埋点 SDK：批量上报，页面关闭走 sendBeacon；失败静默，不影响产品主链路。 */
export function createBrowserObservability(
  options: BrowserObservabilityOptions = {},
): { track: (input: BrowserEventInput) => void; flush: () => Promise<void>; dispose: () => void } {
  const endpoint = options.endpoint ?? '/api/events';
  const flushSize = options.flushSize ?? DEFAULT_FLUSH_SIZE;
  const queue: QueuedEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let sending = false;

  const bodyOf = (events: readonly QueuedEvent[]): string =>
    JSON.stringify({
      events: events.map((item) => ({
        event: item.event,
        workId: item.workId,
        props: item.props ?? {},
        occurredAt: item.occurredAt,
      })),
    });

  const sendBeacon = (events: readonly QueuedEvent[]): boolean => {
    const navigator = globalThis.navigator;
    if (typeof navigator?.sendBeacon !== 'function') return false;
    return navigator.sendBeacon(endpoint, new Blob([bodyOf(events)], { type: 'application/json' }));
  };

  const flush = async (): Promise<void> => {
    if (sending || queue.length === 0) return;
    sending = true;
    const events = queue.splice(0, flushSize);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const authorization = options.getAuthorization?.();
      if (authorization !== null && authorization !== undefined)
        headers.Authorization = `Bearer ${authorization}`;
      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: bodyOf(events),
        keepalive: true,
      });
      if (!response.ok && events.length > 0) queue.unshift(...events);
    } catch {
      queue.unshift(...events);
    } finally {
      sending = false;
      if (queue.length >= flushSize) void flush();
      else scheduleInterval();
    }
  };

  const scheduleInterval = (): void => {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS);
  };

  const onHide = (): void => {
    if (queue.length === 0) return;
    const events = queue.splice(0, queue.length);
    if (!sendBeacon(events) && events.length > 0) queue.unshift(...events);
  };

  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') onHide();
  };

  globalThis.addEventListener?.('pagehide', onHide);
  globalThis.addEventListener?.('visibilitychange', onVisibilityChange);

  return {
    track(input: BrowserEventInput): void {
      queue.push({ ...input, occurredAt: new Date().toISOString() });
      if (input.event === 'publish_receipt_marked' || queue.length >= flushSize) void flush();
      else scheduleInterval();
    },
    flush,
    dispose(): void {
      if (timer !== null) clearTimeout(timer);
      globalThis.removeEventListener?.('pagehide', onHide);
      globalThis.removeEventListener?.('visibilitychange', onVisibilityChange);
    },
  };
}
