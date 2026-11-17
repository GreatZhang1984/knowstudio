import { createBrowserObservability } from '@knowstudio/observability/browser';
import { readAccessToken } from '../pages/login/auth-session';

const client = createBrowserObservability({
  endpoint: '/api/events',
  getAuthorization: () => readAccessToken(),
});

export function trackFirstScriptEdit(
  workId: string,
  previousText: string,
  nextText: string,
): void {
  const storageKey = `ks:event:first-edit:${workId}`;
  if (window.localStorage.getItem(storageKey) !== null) return;
  const denominator = Math.max(previousText.length, nextText.length, 1);
  const changedChars = previousText
    .split('\n')
    .reduce(
      (sum, line, index) =>
        sum + Math.abs(line.length - (nextText.split('\n')[index]?.length ?? 0)),
      0,
    );
  window.localStorage.setItem(storageKey, new Date().toISOString());
  client.track({
    event: 'script_first_edit',
    workId,
    props: { editDistanceRatio: Math.min(1, changedChars / denominator) },
  });
}

export function trackPublishReceipt(workId: string, platformId: string): void {
  client.track({
    event: 'publish_receipt_marked',
    workId,
    props: { platformId },
  });
}
