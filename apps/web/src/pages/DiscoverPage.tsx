import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Button } from 'antd';
import type { Material, SearchSession } from '@knowstudio/contracts';
import { DiscoverView } from './discover/DiscoverView';
import {
  apiErrorOf,
  isSameKeyword,
  searchInputIssue,
  searchViewState,
  withMaterialCollected,
} from './discover/searchLogic';
import {
  collectMaterial,
  createWork,
  fetchSearchSession,
  startSearch,
  type SearchStart,
} from '../work/api';
import { invalidateWork, useCurrentWork, workKeys } from '../work/queries';

interface SearchSubmitInput {
  readonly keyword: string;
  readonly domain?: string;
  readonly force: boolean;
}

interface ActiveSearch {
  readonly workId: string;
  readonly searchId: string;
  readonly keyword: string;
  readonly domain: string;
  readonly startedAt: number;
}

interface StartResult {
  readonly workId: string;
  readonly created: boolean;
  readonly outcome: SearchStart;
}

interface CollectVariables {
  readonly material: Material;
  readonly next: boolean;
}

interface CollectContext {
  readonly key: readonly unknown[];
  readonly previous: SearchSession | undefined;
}

const SEARCH_TIMEOUT_MS = 60_000;

function normalizedDomain(domain: string): string {
  return domain.trim().normalize('NFKC').toLowerCase().replace(/\s+/g, ' ');
}

export default function DiscoverPage() {
  const queryClient = useQueryClient();
  const { message } = AntApp.useApp();
  const { workId, recent, envelope } = useCurrentWork();
  const [keyword, setKeyword] = useState('');
  const [domain, setDomain] = useState('');
  const [activeSearch, setActiveSearch] = useState<ActiveSearch | null>(null);
  const [localSession, setLocalSession] = useState<SearchSession | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const [collectError, setCollectError] = useState<ReturnType<typeof apiErrorOf>>(null);
  const [collectFailed, setCollectFailed] = useState(false);
  const keywordTouched = useRef(false);
  const previousWorkId = useRef(workId);

  useEffect(() => {
    if (keywordTouched.current || envelope.data?.keyword == null) return;
    setKeyword(envelope.data.keyword);
  }, [envelope.data?.keyword]);

  // 只在已有 Work 被切换成另一个 Work 时清空结果；首次从“无 Work”创建时保留新搜索。
  useEffect(() => {
    if (previousWorkId.current != null && workId !== previousWorkId.current) {
      setActiveSearch(null);
      setLocalSession(null);
      setTimedOut(false);
      setCollectFailed(false);
      setCollectError(null);
    }
    previousWorkId.current = workId;
  }, [workId]);

  const searchQuery = useQuery({
    queryKey: workKeys.search(activeSearch?.workId ?? '', activeSearch?.searchId ?? ''),
    queryFn: () => {
      if (activeSearch == null) throw new Error('没有正在进行的搜索');
      return fetchSearchSession(activeSearch.searchId);
    },
    enabled: activeSearch != null,
    refetchInterval: (query) => {
      if (timedOut) return false;
      const status = query.state.data?.status;
      return status === 'queued' || status === 'running' ? 1_000 : false;
    },
  });

  const session = searchQuery.data ?? localSession;

  useEffect(() => {
    if (activeSearch == null || timedOut) return;
    if (session != null && session.status !== 'queued' && session.status !== 'running') return;
    const remainMs = Math.max(0, activeSearch.startedAt + SEARCH_TIMEOUT_MS - Date.now());
    const timer = window.setTimeout(() => setTimedOut(true), remainMs);
    return () => window.clearTimeout(timer);
  }, [activeSearch, session?.status, session, timedOut]);

  const startMutation = useMutation({
    mutationFn: async (input: SearchSubmitInput): Promise<StartResult> => {
      let targetWorkId = workId;
      let created = false;
      if (targetWorkId == null) {
        const work = await createWork(input.keyword);
        targetWorkId = work.id;
        created = true;
        queryClient.setQueryData(workKeys.envelope(work.id), work);
        queryClient.setQueryData(workKeys.recent, {
          id: work.id,
          title: work.title,
          keyword: work.keyword,
          phase: work.phase,
          step: work.step,
          progress: work.progress,
          gates: work.gates,
          updatedAt: new Date().toISOString(),
        });
      }
      const outcome = await startSearch({
        workId: targetWorkId,
        keyword: input.keyword,
        ...(input.domain == null ? {} : { domain: input.domain }),
        force: input.force,
      });
      return { workId: targetWorkId, created, outcome };
    },
    onSuccess: ({ workId: targetWorkId, created, outcome }, input) => {
      if (created) void queryClient.invalidateQueries({ queryKey: workKeys.recent });
      setTimedOut(false);
      setCollectFailed(false);
      setCollectError(null);
      const result =
        outcome.kind === 'session'
          ? { searchId: outcome.session.id, session: outcome.session }
          : { searchId: outcome.searchId, session: null };
      setActiveSearch({
        workId: targetWorkId,
        searchId: result.searchId,
        keyword: input.keyword,
        domain: input.domain ?? '',
        startedAt: Date.now(),
      });
      setLocalSession(result.session);
      if (result.session != null) {
        queryClient.setQueryData(workKeys.search(targetWorkId, result.searchId), result.session);
      }
    },
  });

  function restoreMaterial(material: Material): void {
    const undoKey = `discover-undo-${material.id}`;
    message.destroy(undoKey);
    collectMutation.mutate({ material, next: true });
  }

  const collectMutation = useMutation({
    mutationFn: ({ material, next }: CollectVariables) => {
      if (activeSearch == null) throw new Error('没有可收藏的搜索结果');
      return collectMaterial(activeSearch.workId, material.id, next);
    },
    onMutate: ({ material, next }): CollectContext => {
      setCollectError(null);
      setCollectFailed(false);
      if (activeSearch == null || session == null) {
        return { key: [], previous: undefined };
      }
      const key = workKeys.search(activeSearch.workId, activeSearch.searchId);
      const previous = queryClient.getQueryData<SearchSession>(key);
      queryClient.setQueryData(key, withMaterialCollected(session, material.id, next));
      setLocalSession(withMaterialCollected(session, material.id, next));
      return { key, previous };
    },
    onSuccess: ({ collectedCount }, { material, next }) => {
      if (activeSearch == null) return;
      void queryClient.invalidateQueries({
        queryKey: workKeys.search(activeSearch.workId, activeSearch.searchId),
      });
      void invalidateWork(queryClient, activeSearch.workId);
      if (next) {
        message.success(`已收藏，当前 ${collectedCount} 条素材`);
        return;
      }
      const undoKey = `discover-undo-${material.id}`;
      message.open({
        key: undoKey,
        content: (
          <span className="discover-undo">
            已取消收藏
            <Button type="link" size="small" onClick={() => restoreMaterial(material)}>
              撤销
            </Button>
          </span>
        ),
        duration: 5,
      });
    },
    onError: (error, _variables, context) => {
      setCollectError(apiErrorOf(error));
      setCollectFailed(true);
      if (context?.key.length != null && context.key.length > 0 && context.previous != null) {
        queryClient.setQueryData(context.key, context.previous);
        setLocalSession(context.previous);
      }
    },
  });

  const submitSearch = (force: boolean): void => {
    const nextKeyword = keyword.trim();
    const nextDomain = domain.trim();
    if (searchInputIssue(nextKeyword, nextDomain) != null) return;
    const unchanged =
      session != null &&
      session.status === 'succeeded' &&
      session.partialErrors.length === 0 &&
      isSameKeyword(session.keyword, nextKeyword) &&
      normalizedDomain(activeSearch?.domain ?? '') === normalizedDomain(nextDomain);
    if (!force && unchanged) {
      message.info('已是最新结果');
      return;
    }
    const retryFailedSession =
      session != null && (session.status === 'failed' || session.status === 'canceled');
    startMutation.mutate({
      keyword: nextKeyword,
      ...(nextDomain === '' ? {} : { domain: nextDomain }),
      force: force || retryFailedSession,
    });
  };

  const activeErrorSource = startMutation.isError ? startMutation.error : searchQuery.error;
  const activeError = apiErrorOf(activeErrorSource);
  const workLoading = workId == null && recent.isPending;
  const view =
    workLoading && session == null
      ? ({ kind: 'loading', session: null } as const)
      : searchViewState({
          session,
          submitting: startMutation.isPending || (activeSearch != null && session == null),
          error: activeErrorSource,
          timedOut,
        });
  const sameResult =
    session != null &&
    session.status === 'succeeded' &&
    session.partialErrors.length === 0 &&
    isSameKeyword(session.keyword, keyword) &&
    normalizedDomain(activeSearch?.domain ?? '') === normalizedDomain(domain);

  return (
    <DiscoverView
      workId={workId}
      workTitle={envelope.data?.title}
      workLoading={workLoading}
      keyword={keyword}
      domain={domain}
      sameResult={sameResult}
      submitting={startMutation.isPending}
      session={session}
      view={view}
      error={activeError}
      collectError={collectError}
      collectFailed={collectFailed}
      collectingMaterialId={
        collectMutation.isPending && collectMutation.variables != null
          ? collectMutation.variables.material.id
          : null
      }
      onKeywordChange={(value) => {
        keywordTouched.current = true;
        setKeyword(value);
      }}
      onDomainChange={setDomain}
      onSubmit={() => submitSearch(false)}
      onRetry={() => submitSearch(true)}
      onToggleCollect={(material) =>
        collectMutation.mutate({ material, next: !material.collected })
      }
    />
  );
}
