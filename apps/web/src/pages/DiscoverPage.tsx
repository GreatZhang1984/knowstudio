import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Button } from 'antd';
import type {
  Material,
  MaterialSource,
  MaterialSourceId,
  SearchSession,
} from '@knowstudio/contracts';
import { DiscoverView } from './discover/DiscoverView';
import {
  apiErrorOf,
  isSameKeyword,
  isSameSourceSelection,
  normalizeSourceSelection,
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
import { invalidateWork, useCurrentWork, useMaterialSources, workKeys } from '../work/queries';

interface SearchSubmitInput {
  readonly keyword: string;
  readonly domain?: string;
  readonly force: boolean;
  readonly sources: readonly MaterialSourceId[];
}

interface ActiveSearch {
  readonly workId: string;
  readonly searchId: string;
  readonly keyword: string;
  readonly domain: string;
  readonly sources: readonly string[];
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
const SOURCE_STORAGE_KEY = 'knowstudio.materialSources';
const FALLBACK_SOURCES: readonly MaterialSource[] = [
  { id: 'recorded', name: '录制演示', description: '内置素材。', configured: true },
];

function normalizedDomain(domain: string): string {
  return domain.trim().normalize('NFKC').toLowerCase().replace(/\s+/g, ' ');
}

function readStoredSources(): MaterialSourceId[] | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(SOURCE_STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const valid = new Set<MaterialSourceId>(['recorded', 'web_search', 'obsidian']);
    const selected = parsed.filter(
      (item): item is MaterialSourceId =>
        typeof item === 'string' && valid.has(item as MaterialSourceId),
    );
    return selected;
  } catch {
    return null;
  }
}

export default function DiscoverPage() {
  const queryClient = useQueryClient();
  const { message } = AntApp.useApp();
  const { workId, recent, envelope } = useCurrentWork();
  const sourcesQuery = useMaterialSources();
  const [keyword, setKeyword] = useState('');
  const [domain, setDomain] = useState('');
  const [selectedSourceIds, setSelectedSourceIds] = useState<MaterialSourceId[]>(
    () => readStoredSources() ?? ['recorded'],
  );
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

  useEffect(() => {
    if (sourcesQuery.data === undefined) return;
    setSelectedSourceIds((current) => normalizeSourceSelection(current, sourcesQuery.data.items));
  }, [sourcesQuery.data]);

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
        sources: input.sources,
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
        sources: input.sources,
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
      normalizedDomain(activeSearch?.domain ?? '') === normalizedDomain(nextDomain) &&
      isSameSourceSelection(activeSearch?.sources ?? ['recorded'], selectedSourceIds);
    if (!force && unchanged) {
      message.info('已是最新结果');
      return;
    }
    const retryFailedSession =
      session != null && (session.status === 'failed' || session.status === 'canceled');
    startMutation.mutate({
      keyword: nextKeyword,
      ...(nextDomain === '' ? {} : { domain: nextDomain }),
      sources: selectedSourceIds,
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
    normalizedDomain(activeSearch?.domain ?? '') === normalizedDomain(domain) &&
    isSameSourceSelection(activeSearch?.sources ?? ['recorded'], selectedSourceIds);
  const materialSources = sourcesQuery.data?.items ?? FALLBACK_SOURCES;

  return (
    <DiscoverView
      workId={workId}
      workTitle={envelope.data?.title}
      workLoading={workLoading}
      keyword={keyword}
      domain={domain}
      materialSources={materialSources}
      selectedSourceIds={selectedSourceIds}
      sourcesLoading={sourcesQuery.isPending}
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
      onToggleSource={(source) => {
        if (!source.configured) return;
        const next = normalizeSourceSelection(
          selectedSourceIds.includes(source.id)
            ? selectedSourceIds.filter((id) => id !== source.id)
            : [...selectedSourceIds, source.id as MaterialSourceId],
          materialSources,
        );
        setSelectedSourceIds(next);
        localStorage.setItem(SOURCE_STORAGE_KEY, JSON.stringify(next));
      }}
      onSubmit={() => submitSearch(false)}
      onRetry={() => submitSearch(true)}
      onToggleCollect={(material) =>
        collectMutation.mutate({ material, next: !material.collected })
      }
    />
  );
}
