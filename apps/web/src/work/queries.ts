import { useQuery } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import type { PlatformId } from '@knowstudio/contracts';
import { fetchMetrics, fetchQuota, fetchRecentWork, fetchWorkEnvelope } from './api';

/**
 * queryKey 一律带 workId，天然按作品隔离（架构 §11.2）。
 *
 * 约定（新增 key 必须遵守，test/queryKeys.test.ts 会遍历断言）：
 * - **work 范围**的 key 一律是 `['work', workId, ...]`：workId 固定在第 1 位，
 *   于是 `['work', workId]` 既是信封 key，又是「这个 Work 的全部缓存」的前缀，
 *   mutation 成功后一次 invalidate 就能精确清掉一个 Work，不殃及别的 Work。
 * - **全局范围**只允许 recent 与 quota 两个（它们本来就与 workId 无关）。
 *   quota 是侧栏/顶栏/配额页三处同源的唯一 key（AC-H3），不许拆成多份。
 */
export const workKeys = {
  /** 信封：gates/step/progress/quota。同时是本 work 全部缓存的 invalidate 前缀。 */
  envelope: (workId: string) => ['work', workId] as const,
  script: (workId: string) => ['work', workId, 'script'] as const,
  topics: (workId: string, batchIndex: number) => ['work', workId, 'topics', batchIndex] as const,
  /** 四平台各自一行，独立 mutation（AC-P4）。 */
  derivatives: (workId: string) => ['work', workId, 'derivatives'] as const,
  derivative: (workId: string, platformId: PlatformId) =>
    ['work', workId, 'derivatives', platformId] as const,
  compliance: (workId: string) => ['work', workId, 'compliance'] as const,
  exportPackage: (workId: string, exportId: string) =>
    ['work', workId, 'export', exportId] as const,
  /**
   * 渲染任务。架构 §11.2 示例写的是 `['job', jobId]`（跨页面共享），
   * 但同一节的硬规则是「queryKey 一律带 workId」。这里服从硬规则：
   * jobId 前置 workId 后仍然跨页面共享（同一 work 的任何页面拼出的 key 完全相同），
   * 同时不会因为切 Work 而读到上一个 Work 的任务。见报告 [待确认] 项。
   */
  job: (workId: string, jobId: string) => ['work', workId, 'job', jobId] as const,
  /** 搜索会话。收藏会改变会话内素材的 collected 位，故必须挂在 work 缓存前缀下。 */
  search: (workId: string, searchId: string) => ['work', workId, 'search', searchId] as const,
  /** 用户级素材库：收藏态跨 Work 去重，与 workId 无关。 */
  library: (q: string, type: string | undefined, license: string | undefined) =>
    ['library', q, type ?? '', license ?? ''] as const,
  styleSamples: () => ['style-samples'] as const,
  styleProfile: () => ['style-profile'] as const,
  recent: ['works', 'recent'] as const,
  quota: ['quota'] as const,
  metrics: ['metrics'] as const,
  ledger: (month: string) => [...workKeys.quota, 'ledger', month] as const,
  platformRules: ['platform-rules'] as const,
};

/** mutation 成功后清掉**这一个** Work 的服务端缓存；不碰其他 Work，也不碰全局 quota。 */
export function invalidateWork(queryClient: QueryClient, workId: string): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: workKeys.envelope(workId) });
}

export function invalidateQuota(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: workKeys.quota });
}

export function useWorkEnvelope(workId: string | undefined) {
  return useQuery({
    queryKey: workKeys.envelope(workId ?? ''),
    queryFn: () => fetchWorkEnvelope(workId ?? ''),
    enabled: workId != null && workId.length > 0,
  });
}

export function useRecentWork() {
  return useQuery({ queryKey: workKeys.recent, queryFn: fetchRecentWork });
}

/**
 * 侧栏额度条 / 顶栏 pill / 配额页三处共用这一个 queryKey，
 * 保证同源同刻（架构 §11.4 模式 5 · AC-H3）。
 */
export function useQuota() {
  return useQuery({ queryKey: workKeys.quota, queryFn: fetchQuota });
}

export function useMetrics() {
  return useQuery({ queryKey: workKeys.metrics, queryFn: fetchMetrics });
}

/** 当前作品：路由上有 :id 就用它，否则回落到最近活跃 Work。 */
export function useCurrentWork() {
  const { id } = useParams();
  const recent = useRecentWork();
  const workId = id ?? recent.data?.id;
  const envelope = useWorkEnvelope(workId);
  return { workId, recent, envelope };
}
