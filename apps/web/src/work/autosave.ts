import type { DraftEnvelope, DraftPort } from '@knowstudio/ui';

const DB_NAME = 'knowstudio-drafts';
const STORE = 'drafts';

function request<T>(event: IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    event.onsuccess = () => resolve(event.result as T);
    event.onerror = () => reject(event.error);
  });
}

async function store(mode: IDBTransactionMode): Promise<IDBObjectStore | null> {
  if (typeof indexedDB === 'undefined') return null;
  const open = indexedDB.open(DB_NAME, 1);
  open.onupgradeneeded = () => {
    if (!open.result.objectStoreNames.contains(STORE)) open.result.createObjectStore(STORE);
  };
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  return db.transaction(STORE, mode).objectStore(STORE);
}

/** T-16 的浏览器暂存实现；SSR/隐私模式退化为不可用，调用方仍保留内存态。 */
export const indexedDbDraftPort: DraftPort = {
  async save(draft: DraftEnvelope): Promise<void> {
    const objectStore = await store('readwrite');
    if (objectStore === null) return;
    await request<void>(objectStore.put(draft, draft.key));
  },
  async load(key: string): Promise<DraftEnvelope | null> {
    const objectStore = await store('readonly');
    if (objectStore === null) return null;
    return request<DraftEnvelope | null>(objectStore.get(key));
  },
  async clear(key: string): Promise<void> {
    const objectStore = await store('readwrite');
    if (objectStore === null) return;
    await request<void>(objectStore.delete(key));
  },
};
