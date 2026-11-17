import { describe, expect, it } from 'vitest';
import { createObjectStorage, draftKey, exportKey, layerKey } from '../src/index.js';

/**
 * 本文件只验证**离线可计算**的部分：SigV4 预签名 URL 的生成是纯本地计算，不需要对象存储服务。
 *
 * 【阻塞未验证】live PUT/GET 上下行、签名 URL 的真实可用性、Lifecycle 规则的实际下发与到期清理，
 * 均需真实 MinIO/S3。本机 MinIO 镜像拉取被 registry denied、无 MinIO 服务在跑，
 * 故上述项一律未验证，不用 mock 冒充。解锁需先取得可用的 S3 兼容服务端。
 */
const storage = createObjectStorage({
  endpoint: 'http://127.0.0.1:9000',
  region: 'us-east-1',
  bucket: 'knowstudio-dev',
  accessKeyId: 'test-access-key',
  secretAccessKey: 'test-secret-key',
  forcePathStyle: true,
});

function params(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

describe('预签名 URL 生成（离线 SigV4）', () => {
  it('缺省有效期 24h，符合架构 §10.3 / §6.8', async () => {
    const url = await storage.presignGet({ key: exportKey({ userId: 'u1', workId: 'w1', exportId: 'e1' }) });
    expect(params(url).get('X-Amz-Expires')).toBe('86400');
  });

  it('按产物类别取 §6.8 的签名有效期：分层 1h，草稿/成片/导出 24h', async () => {
    const layer = await storage.presignGet({
      key: layerKey({ userId: 'u1', workId: 'w1', kind: 'audio', version: 1 }),
      artifact: 'layer',
    });
    expect(params(layer).get('X-Amz-Expires')).toBe('3600');

    for (const artifact of ['draft', 'video', 'export'] as const) {
      const url = await storage.presignGet({ key: 'videos/u1/w1/x', artifact });
      expect(params(url).get('X-Amz-Expires')).toBe('86400');
    }
  });

  it('显式 expiresInSeconds 覆盖类别缺省（过期重签场景）', async () => {
    const url = await storage.presignGet({ key: 'exports/u1/w1/e1', expiresInSeconds: 600 });
    expect(params(url).get('X-Amz-Expires')).toBe('600');
  });

  it('PUT 与 GET 都签，签名只覆盖 host', async () => {
    const put = await storage.presignPut({ key: draftKey({ userId: 'u1', workId: 'w1' }) });
    expect(params(put).get('X-Amz-Expires')).toBe('86400');
    expect(params(put).get('X-Amz-SignedHeaders')).toBe('host');
    expect(params(put).get('x-id')).toBe('PutObject');

    const get = await storage.presignGet({ key: 'videos/u1/w1/draft' });
    expect(params(get).get('X-Amz-SignedHeaders')).toBe('host');
    expect(params(get).get('x-id')).toBe('GetObject');
  });

  it('预签名 URL 不含默认载荷校验和——否则真实 PUT 必然校验失败', async () => {
    for (const url of [
      await storage.presignPut({ key: 'videos/u1/w1/draft' }),
      await storage.presignGet({ key: 'videos/u1/w1/draft' }),
    ]) {
      const keys = [...params(url).keys()];
      expect(keys.filter((k) => k.startsWith('x-amz-checksum'))).toEqual([]);
      expect(keys).not.toContain('x-amz-sdk-checksum-algorithm');
      expect(params(url).get('X-Amz-Content-Sha256')).toBe('UNSIGNED-PAYLOAD');
    }
  });

  it('URL 指向配置的 endpoint/bucket/key（path-style）', async () => {
    const url = new URL(await storage.presignGet({ key: 'videos/u1/w1/hd' }));
    expect(url.origin).toBe('http://127.0.0.1:9000');
    expect(url.pathname).toBe('/knowstudio-dev/videos/u1/w1/hd');
  });

  it('带完整 SigV4 要素：算法、凭据 scope、64 位十六进制签名', async () => {
    const p = params(await storage.presignGet({ key: 'exports/u1/w1/e1' }));
    expect(p.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(p.get('X-Amz-Credential')).toContain('test-access-key/');
    expect(p.get('X-Amz-Credential')).toContain('/us-east-1/s3/aws4_request');
    expect(p.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(p.get('X-Amz-Date')).toMatch(/^\d{8}T\d{6}Z$/);
  });

  it('不同 key 签出不同签名，签名不是常量', async () => {
    const a = params(await storage.presignGet({ key: 'exports/u1/w1/e1' })).get('X-Amz-Signature');
    const b = params(await storage.presignGet({ key: 'exports/u1/w1/e2' })).get('X-Amz-Signature');
    expect(a).not.toBe(b);
  });

  it('授权凭证是内部产物，PUT/GET 都不签发', async () => {
    await expect(storage.presignGet({ key: 'evidence/u1/m1' })).rejects.toThrow(/内部产物不签发/);
    await expect(storage.presignPut({ key: 'evidence/u1/m1' })).rejects.toThrow(/内部产物不签发/);
  });
});