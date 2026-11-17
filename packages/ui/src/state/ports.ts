/**
 * 异常态基座对外部世界的两个端口（port）。
 *
 * **本文件只定义接口，不实现存储。** 离线暂存队列（IndexedDB、按键脏标记、
 * 恢复重放、baseVersion 冲突三选）是 T-16 的范围，这里刻意留空，
 * 由 T-16 注入实现；T-08 只保证「横幅会在正确的时机调用正确的端口方法」。
 */

/** 一次暂存的信封。savedAt 用于恢复后按时间戳重放（架构 §11.3）。 */
export interface DraftEnvelope<T = unknown> {
  key: string;
  /** RFC3339 UTC（架构 §10.1：时间一律 UTC，前端本地化）。 */
  savedAt: string;
  payload: T;
  /** 冲突判定用的服务端版本；恢复重放时作为 baseVersion 带上（架构 §11.3）。 */
  baseVersion?: number;
}

/** 屏在断网瞬间交出的当前输入。返回 null 表示「没有需要暂存的东西」。 */
export interface DraftInput<T = unknown> {
  payload: T;
  baseVersion?: number;
}

/**
 * 暂存端口。全异步：真实实现是 IndexedDB，同步签名会诱导调用方写出阻塞主线程的假实现。
 * 约定：
 * - `save` 覆盖同 key 的旧暂存（同一屏只保留最新一份，重放顺序由 savedAt 决定）。
 * - `load` 无暂存时返回 null，不抛异常。
 * - `clear` 幂等，删不存在的 key 也算成功。
 */
export interface DraftPort<T = unknown> {
  save(draft: DraftEnvelope<T>): Promise<void>;
  load(key: string): Promise<DraftEnvelope<T> | null>;
  clear(key: string): Promise<void>;
}

/** 联网状态端口。抽出来是为了让横幅能在单测里被确定性地驱动。 */
export interface ConnectivityPort {
  isOnline(): boolean;
  /** 返回取消订阅函数。 */
  subscribe(listener: (online: boolean) => void): () => void;
}

/**
 * 浏览器默认实现：navigator.onLine + online/offline 事件。
 * 只读联网状态，不做任何请求探活（探活策略属于各屏的 query 层）。
 * 非浏览器环境（SSR / 单测）退化为「恒在线、无事件」，不抛异常。
 */
export const browserConnectivity: ConnectivityPort = {
  isOnline: () => (typeof navigator === 'undefined' ? true : navigator.onLine !== false),
  subscribe: (listener) => {
    if (typeof window === 'undefined') return () => {};
    const on = (): void => listener(true);
    const off = (): void => listener(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  },
};