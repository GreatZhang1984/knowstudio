import type { ArtifactKind } from './keys.js';
import type { Readable } from 'node:stream';

export interface ObjectStorageConfig {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** MinIO 必须 true；阿里云 OSS / AWS S3 用虚拟主机风格。 */
  readonly forcePathStyle?: boolean;
}

export interface PutObjectInput {
  readonly key: string;
  readonly body: Uint8Array | string | Readable;
  readonly contentType?: string;
  /** 决定 Lifecycle 标签；draft/video 共用前缀，缺标签则保留期规则不命中。 */
  readonly artifact?: ArtifactKind;
}

export interface StoredObject {
  readonly body: Uint8Array;
  readonly contentType?: string;
  readonly contentLength?: number;
}

/**
 * 刻意不提供 contentType：@aws-sdk/s3-request-presigner 在 prepareRequest 里
 * 硬编码 unsignableHeaders.add('content-type')，Content-Type 永远进不了签名
 * （已探针取证：带与不带 ContentType 签出的 X-Amz-Signature 逐字相同）。
 * 提供它只会是「看起来绑定了、实际没绑定」的假承诺。客户端可自行发送该头。
 */
export interface PresignInput {
  readonly key: string;
  readonly artifact?: ArtifactKind;
  readonly expiresInSeconds?: number;
}

export interface ObjectStorage {
  putObject(input: PutObjectInput): Promise<void>;
  getObject(key: string): Promise<StoredObject>;
  deleteObject(key: string): Promise<void>;
  presignPut(input: PresignInput): Promise<string>;
  presignGet(input: PresignInput): Promise<string>;
  applyLifecycleRules(): Promise<void>;
}
