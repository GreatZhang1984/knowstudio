/**
 * 架构 §6.8 产物生命周期表（spark-output/architecture/knowledge-video-tool.md:1522-1528）。
 * 保留期与签名有效期照抄原文；原文标 [推断] 的两项在此保留标记，校准属产品决策。
 */
export type ArtifactKind = 'layer' | 'draft' | 'video' | 'export' | 'evidence';

export interface ArtifactPolicy {
  readonly prefix: string;
  readonly retentionDays: number;
  /** null = 内部产物，不签发对外 URL（§6.8 授权凭证列「内部」）。 */
  readonly signTtlSec: number | null;
  readonly retentionIsMinimum: boolean;
  readonly retentionInferred: boolean;
}

export const ARTIFACT_POLICY: Readonly<Record<ArtifactKind, ArtifactPolicy>> = {
  layer: {
    prefix: 'layers/',
    retentionDays: 30,
    signTtlSec: 3600,
    retentionIsMinimum: false,
    retentionInferred: true,
  },
  draft: {
    prefix: 'videos/',
    retentionDays: 7,
    signTtlSec: 86_400,
    retentionIsMinimum: false,
    retentionInferred: false,
  },
  video: {
    prefix: 'videos/',
    retentionDays: 30,
    signTtlSec: 86_400,
    retentionIsMinimum: false,
    retentionInferred: true,
  },
  export: {
    prefix: 'exports/',
    retentionDays: 7,
    signTtlSec: 86_400,
    retentionIsMinimum: true,
    retentionInferred: false,
  },
  evidence: {
    prefix: 'evidence/',
    retentionDays: 1095,
    signTtlSec: null,
    retentionIsMinimum: false,
    retentionInferred: true,
  },
};

export const DEFAULT_SIGN_TTL_SEC = 86_400;

/**
 * 键片段是访问控制边界：桶内按 {userId} 前缀隔离产物，
 * 若放行 '/' 或 '..'，一个 workId 就能越出本人前缀读写他人对象。
 */
function segment(value: string, name: string): string {
  const illegal =
    value.length === 0 ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\') ||
    [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
  if (illegal) {
    throw new Error(`非法存储键片段 ${name}: ${JSON.stringify(value)}`);
  }
  return value;
}

export function layerKey(p: {
  userId: string;
  workId: string;
  kind: string;
  version: string | number;
}): string {
  return `layers/${segment(p.userId, 'userId')}/${segment(p.workId, 'workId')}/${segment(p.kind, 'kind')}/${segment(String(p.version), 'version')}`;
}

export function draftKey(p: { userId: string; workId: string }): string {
  return `videos/${segment(p.userId, 'userId')}/${segment(p.workId, 'workId')}/draft`;
}

/** variant 是画质或平台派生标识（§6.8 的 {quality|platform}）。 */
export function videoKey(p: { userId: string; workId: string; variant: string }): string {
  return `videos/${segment(p.userId, 'userId')}/${segment(p.workId, 'workId')}/${segment(p.variant, 'variant')}`;
}

export function exportKey(p: { userId: string; workId: string; exportId: string }): string {
  return `exports/${segment(p.userId, 'userId')}/${segment(p.workId, 'workId')}/${segment(p.exportId, 'exportId')}`;
}

export function evidenceKey(p: { userId: string; materialId: string }): string {
  return `evidence/${segment(p.userId, 'userId')}/${segment(p.materialId, 'materialId')}`;
}

export function isInternalKey(key: string): boolean {
  return key.startsWith(ARTIFACT_POLICY.evidence.prefix);
}