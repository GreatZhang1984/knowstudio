import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sleep, startRedisFixture, stopRedisFixture, type RedisFixture } from './helpers.js';

interface ProgressEvent {
  readonly jobId: string;
  readonly percent: number;
}

describe('Redis PubSub（SSE 跨实例扇出）', () => {
  let f: RedisFixture;
  let other: RedisFixture;

  beforeAll(async () => {
    f = await startRedisFixture('pubsub');
    other = await startRedisFixture('pubsub-other');
  });
  afterAll(async () => {
    await stopRedisFixture(f);
    await stopRedisFixture(other);
  });

  it('JSON 事件往返保真，publish 返回收到者数', async () => {
    const received: ProgressEvent[] = [];
    const unsubscribe = await f.client.pubsub.subscribe<ProgressEvent>('render:j1', (e) => {
      received.push(e);
    });
    try {
      const event = { jobId: 'j1', percent: 42 };
      expect(await f.client.pubsub.publish('render:j1', event)).toBe(1);
      await sleep(150);
      expect(received).toEqual([event]);
    } finally {
      await unsubscribe();
    }
  });

  it('同一频道多个订阅者都收到（本地扇出）', async () => {
    const a: number[] = [];
    const b: number[] = [];
    const offA = await f.client.pubsub.subscribe<number>('fanout', (n) => a.push(n));
    const offB = await f.client.pubsub.subscribe<number>('fanout', (n) => b.push(n));
    try {
      expect(await f.client.pubsub.publish('fanout', 7)).toBe(1);
      await sleep(150);
      expect(a).toEqual([7]);
      expect(b).toEqual([7]);
    } finally {
      await offA();
      await offB();
    }
  });

  it('退订后不再投递，且频道从 Redis 消失', async () => {
    const received: number[] = [];
    const off = await f.client.pubsub.subscribe<number>('temp', (n) => received.push(n));
    await f.client.pubsub.publish('temp', 1);
    await sleep(150);
    await off();
    expect(await f.client.pubsub.publish('temp', 2)).toBe(0);
    await sleep(150);
    expect(received).toEqual([1]);
    expect(await f.raw.pubsub('CHANNELS')).not.toContain(`${f.prefix}temp`);
  });

  it('不同 keyPrefix 的同名频道互相隔离（频道是实例级全局命名空间）', async () => {
    const mine: string[] = [];
    const theirs: string[] = [];
    const offMine = await f.client.pubsub.subscribe<string>('shared', (m) => mine.push(m));
    const offTheirs = await other.client.pubsub.subscribe<string>('shared', (m) => theirs.push(m));
    try {
      await f.client.pubsub.publish('shared', 'from-f');
      await other.client.pubsub.publish('shared', 'from-other');
      await sleep(200);
      expect(mine).toEqual(['from-f']);
      expect(theirs).toEqual(['from-other']);
    } finally {
      await offMine();
      await offTheirs();
    }
  });

  it('无订阅者时 publish 返回 0，不抛错', async () => {
    expect(await f.client.pubsub.publish('nobody', { x: 1 })).toBe(0);
  });
});