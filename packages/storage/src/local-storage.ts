import { createWriteStream } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import type {
  ObjectStorage,
  ObjectStorageConfig,
  PresignInput,
  PutObjectInput,
  StoredObject,
} from './types.js';

function keyPath(root: string, key: string): string {
  if (key.length === 0 || key.includes('\\') || key.includes('..')) {
    throw new Error(`非法对象键: ${JSON.stringify(key)}`);
  }
  const full = resolve(root, ...key.split('/'));
  const normalizedRoot = resolve(root);
  if (full !== normalizedRoot && !full.startsWith(normalizedRoot + sep)) {
    throw new Error(`对象键越界: ${JSON.stringify(key)}`);
  }
  return full;
}

function storageUrl(key: string): string {
  return `/api/local-storage/${key.split('/').map(encodeURIComponent).join('/')}`;
}

function contentTypeOf(key: string): string {
  if (key.endsWith('.mp4')) return 'video/mp4';
  if (key.endsWith('.svg')) return 'image/svg+xml';
  if (key.endsWith('.vtt')) return 'text/vtt';
  if (key.endsWith('.json')) return 'application/json';
  if (key.endsWith('.wav')) return 'audio/wav';
  return 'application/octet-stream';
}

/** 本地开发/单机部署存储。签名 URL 由 API 的 /local-storage 路由兑现。 */
export function createLocalStorage(config: ObjectStorageConfig & { root: string }): ObjectStorage {
  return {
    async putObject(input: PutObjectInput): Promise<void> {
      const file = keyPath(config.root, input.key);
      await mkdir(dirname(file), { recursive: true });
      const body = input.body;
      if (body != null && typeof (body as Readable).pipe === 'function') {
        await pipeline(body as Readable, createWriteStream(file));
        return;
      }
      if (typeof body === 'string') await writeFile(file, Buffer.from(body, 'utf8'));
      else
        await writeFile(
          file,
          Buffer.from((body as Uint8Array).buffer, (body as Uint8Array).byteOffset, (body as Uint8Array).byteLength),
        );
    },
    async getObject(key: string): Promise<StoredObject> {
      const body = await readFile(keyPath(config.root, key));
      return {
        body: new Uint8Array(body),
        contentLength: body.byteLength,
        contentType: contentTypeOf(key),
      };
    },
    async deleteObject(key: string): Promise<void> {
      await unlink(keyPath(config.root, key)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    },
    async presignPut(input: PresignInput): Promise<string> {
      keyPath(config.root, input.key);
      return storageUrl(input.key);
    },
    async presignGet(input: PresignInput): Promise<string> {
      keyPath(config.root, input.key);
      return storageUrl(input.key);
    },
    async applyLifecycleRules(): Promise<void> {
      // 本地模式由部署脚本/运维清理；不假装已接入桶级 Lifecycle。
    },
  };
}

export function localStorageRoot(): string {
  return normalize(join(process.cwd(), '.local-storage'));
}
