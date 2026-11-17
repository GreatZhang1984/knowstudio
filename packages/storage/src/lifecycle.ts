import type { LifecycleRule } from '@aws-sdk/client-s3';
import { ARTIFACT_POLICY, type ArtifactKind } from './keys.js';

export const ARTIFACT_TAG = 'artifact';

/**
 * §6.8 要求生命周期用桶级 Lifecycle Rule 实现，但草稿(7天)与高清/派生(30天)
 * 共用 `videos/{userId}/{workId}/…` 前缀，末段随用户与作品变化，
 * 单靠前缀过滤无法区分两者。故这两条规则用 artifact 标签判别，
 * 键布局一字不改（改布局属架构 owner 决策）。写入时必须带 artifact 标签，否则规则不命中。
 */
const TAG_DISCRIMINATED: readonly ArtifactKind[] = ['draft', 'video'];

export function buildLifecycleRules(): LifecycleRule[] {
  return (Object.keys(ARTIFACT_POLICY) as ArtifactKind[]).map((kind) => {
    const policy = ARTIFACT_POLICY[kind];
    const filter = TAG_DISCRIMINATED.includes(kind)
      ? { And: { Prefix: policy.prefix, Tags: [{ Key: ARTIFACT_TAG, Value: kind }] } }
      : { Prefix: policy.prefix };
    return {
      ID: `knowstudio-${kind}-${policy.retentionDays}d`,
      Status: 'Enabled',
      Filter: filter,
      Expiration: { Days: policy.retentionDays },
    };
  });
}

export function artifactTagging(kind: ArtifactKind): string {
  return `${ARTIFACT_TAG}=${kind}`;
}