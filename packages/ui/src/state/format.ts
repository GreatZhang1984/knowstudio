/**
 * 异常态文案里的纯格式化函数。零依赖、无 IO，可直接单测。
 * 抽出来是为了让「文案选择」成为可测逻辑，而不是埋在 JSX 里。
 */

/** 413 的 maxBytes 要给用户看得懂的量级，而不是 31457280 这种裸数字。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return `${bytes} B`;
  const units = ['B', 'KB', 'MB', 'GB'] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit] ?? 'B'}`;
}

/** 429 / 503 的 retryAfterSec：0 表示「立刻可重试」，不要写成「0 秒后」。 */
export function formatWaitSeconds(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '马上';
  if (sec < 60) return `${Math.ceil(sec)} 秒`;
  const min = Math.ceil(sec / 60);
  if (min < 60) return `${min} 分钟`;
  const hour = Math.floor(min / 60);
  const rest = min % 60;
  return rest === 0 ? `${hour} 小时` : `${hour} 小时 ${rest} 分钟`;
}

/**
 * 402 的 resetAt 本地化（架构 §10.1：契约一律 UTC，前端本地化）。
 * 默认用浏览器时区；测试注入固定 formatter 以保证确定性。
 */
export function formatTimestamp(iso: string, formatTime?: (iso: string) => string): string {
  if (formatTime != null) return formatTime(iso);
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(at);
}

/**
 * message 的唯一合法用途：映射文案为空时兜底展示。
 * 这里不做任何「message 里含某个词就走某个分支」的判断（架构 §10.2）。
 */
export function bodyOrMessage(body: string, message: string): string {
  const trimmed = body.trim();
  if (trimmed !== '') return trimmed;
  const fallback = message.trim();
  return fallback === '' ? '出了点问题，请稍后重试。' : fallback;
}

/** SPEC §9 全局：未登录 → `/login?returnTo=`。returnTo 必须编码，且保留 loginUrl 已有 query。 */
export function loginTarget(loginUrl: string, returnTo?: string): string {
  if (returnTo == null || returnTo === '') return loginUrl;
  const sep = loginUrl.includes('?') ? '&' : '?';
  return `${loginUrl}${sep}returnTo=${encodeURIComponent(returnTo)}`;
}