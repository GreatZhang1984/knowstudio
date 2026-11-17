import type { Redis } from 'ioredis';

/**
 * ioredis 的 quit() 在 status 仍为 'ready' 时就 resolve（已对真实 Redis 7.4 探针取证，
 * 约 100ms 后才转 'end'）。优雅停机若只 await quit() 就退出进程，socket 尚未释放，
 * 故这里等到 'end' 事件为止，让 close() 的语义与调用方预期一致。
 */
export async function quitAndEnd(redis: Redis): Promise<void> {
  if (redis.status === 'end') return;
  const ended = new Promise<void>((resolve) => redis.once('end', resolve));
  await redis.quit();
  await ended;
}