import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutBucketLifecycleConfigurationCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ARTIFACT_POLICY, DEFAULT_SIGN_TTL_SEC, isInternalKey } from './keys.js';
import { artifactTagging, buildLifecycleRules } from './lifecycle.js';
import type {
  ObjectStorage,
  ObjectStorageConfig,
  PresignInput,
  PutObjectInput,
  StoredObject,
} from './types.js';

function signTtl(input: PresignInput): number {
  if (isInternalKey(input.key)) {
    throw new Error(`内部产物不签发对外 URL: ${input.key}`);
  }
  if (input.expiresInSeconds !== undefined) return input.expiresInSeconds;
  const policy = input.artifact === undefined ? null : ARTIFACT_POLICY[input.artifact];
  return policy?.signTtlSec ?? DEFAULT_SIGN_TTL_SEC;
}

export function createObjectStorage(config: ObjectStorageConfig): ObjectStorage {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle ?? false,
    // SDK 默认给 PutObject 计算空载荷 CRC32 并塞进预签名 URL 的查询串，
    // 客户端上传真实字节时校验和必然不匹配 → 预签名 PUT 直接失败。
    // 关掉默认计算，让签名只覆盖 host（已探针取证 URL 不再含 x-amz-checksum-*）。
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
  const Bucket = config.bucket;

  return {
    async putObject(input: PutObjectInput): Promise<void> {
      await client.send(
        new PutObjectCommand({
          Bucket,
          Key: input.key,
          Body: input.body,
          ContentType: input.contentType,
          Tagging: input.artifact === undefined ? undefined : artifactTagging(input.artifact),
        }),
      );
    },
    async getObject(key: string): Promise<StoredObject> {
      const res = await client.send(new GetObjectCommand({ Bucket, Key: key }));
      if (res.Body === undefined) {
        throw new Error(`对象存储返回空 Body: ${key}`);
      }
      return {
        body: await res.Body.transformToByteArray(),
        contentType: res.ContentType,
        contentLength: res.ContentLength,
      };
    },
    async deleteObject(key: string): Promise<void> {
      await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },
    async presignPut(input: PresignInput): Promise<string> {
      return await getSignedUrl(client, new PutObjectCommand({ Bucket, Key: input.key }), {
        expiresIn: signTtl(input),
      });
    },
    async presignGet(input: PresignInput): Promise<string> {
      return await getSignedUrl(client, new GetObjectCommand({ Bucket, Key: input.key }), {
        expiresIn: signTtl(input),
      });
    },
    async applyLifecycleRules(): Promise<void> {
      await client.send(
        new PutBucketLifecycleConfigurationCommand({
          Bucket,
          LifecycleConfiguration: { Rules: buildLifecycleRules() },
        }),
      );
    },
  };
}