import { Redis } from 'ioredis';
import { quitAndEnd } from './connection.js';

export interface PubSubHub {
  publish<T>(channel: string, payload: T): Promise<number>;
  subscribe<T>(channel: string, handler: (payload: T) => void): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

export interface PubSubOptions {
  /** 发布走主连接：ioredis 进入订阅模式后不能再执行普通命令，故订阅必须另开一条。 */
  readonly connection: Redis;
  readonly url: string;
  readonly keyPrefix: string;
}

/**
 * ioredis 的 keyPrefix 只作用于键命令（含 EVAL 的 KEYS），**不作用于 PubSub 频道**
 * ——已对真实 Redis 7.4 探针取证：带 keyPrefix 的连接 subscribe('ch1') 后，
 * 无前缀连接 PUBSUB CHANNELS 看到的仍是裸 'ch1'。
 * 频道在实例内是全局命名空间，故这里必须自己拼前缀，否则两个工作包会互相收到对方的事件。
 */
export function createPubSubHub(options: PubSubOptions): PubSubHub {
  const fullChannel = (channel: string): string => `${options.keyPrefix}${channel}`;
  const handlers = new Map<string, Set<(payload: unknown) => void>>();
  let subscriber: Redis | null = null;

  const ensureSubscriber = (): Redis => {
    if (subscriber !== null) return subscriber;
    const sub = new Redis(options.url);
    sub.on('message', (channel: string, message: string) => {
      const listeners = handlers.get(channel);
      if (listeners === undefined) return;
      const payload: unknown = JSON.parse(message);
      for (const listener of listeners) listener(payload);
    });
    subscriber = sub;
    return sub;
  };

  return {
    async publish<T>(channel: string, payload: T): Promise<number> {
      return await options.connection.publish(fullChannel(channel), JSON.stringify(payload));
    },
    async subscribe<T>(
      channel: string,
      handler: (payload: T) => void,
    ): Promise<() => Promise<void>> {
      const sub = ensureSubscriber();
      const name = fullChannel(channel);
      let listeners = handlers.get(name);
      if (listeners === undefined) {
        listeners = new Set();
        handlers.set(name, listeners);
        await sub.subscribe(name);
      }
      const listener = handler as (payload: unknown) => void;
      listeners.add(listener);

      return async (): Promise<void> => {
        const current = handlers.get(name);
        if (current === undefined) return;
        current.delete(listener);
        if (current.size === 0) {
          handlers.delete(name);
          await sub.unsubscribe(name);
        }
      };
    },
    async close(): Promise<void> {
      const sub = subscriber;
      subscriber = null;
      handlers.clear();
      if (sub !== null) await quitAndEnd(sub);
    },
  };
}