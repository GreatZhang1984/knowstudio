import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Tag } from 'antd';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { Topic } from '@knowstudio/contracts';
import { EmptyState, ErrorState, LoadingState } from '@knowstudio/ui';
import { fetchTopics, generateTopics, rerollTopics, selectTopic } from '../work/api';
import { invalidateWork, useCurrentWork, workKeys } from '../work/queries';
import { apiErrorOf } from './discover/searchLogic';

function materialIdsFromQuery(raw: string | null): string[] {
  if (raw == null || raw.trim() === '') return [];
  return [
    ...new Set(
      raw
        .split(',')
        .map((id) => id.trim())
        .filter((id) => id !== ''),
    ),
  ];
}

export default function TopicsPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const materialIds = useMemo(
    () => materialIdsFromQuery(searchParams.get('materials')),
    [searchParams],
  );
  const blankAngle = searchParams.get('angle');
  const { workId, envelope, recent } = useCurrentWork();
  const [batchIndex, setBatchIndex] = useState(1);
  const [requested, setRequested] = useState(false);
  const [selectedTopicId, setSelectedTopicId] = useState<string | undefined>();

  const shouldFetch = workId != null && (requested || envelope.data?.selectedTopicId != null);
  const topicsQuery = useQuery({
    queryKey: workKeys.topics(workId ?? '', batchIndex),
    queryFn: () => fetchTopics(workId ?? '', batchIndex),
    enabled: shouldFetch,
  });

  const generateMutation = useMutation({
    mutationFn: () => {
      if (workId == null) throw new Error('没有当前作品');
      return generateTopics(workId, materialIds);
    },
    onSuccess: () => {
      setBatchIndex(1);
      setRequested(true);
      if (workId != null) {
        void queryClient.invalidateQueries({ queryKey: workKeys.topics(workId, 1) });
      }
    },
  });

  const rerollMutation = useMutation({
    mutationFn: () => {
      if (workId == null) throw new Error('没有当前作品');
      return rerollTopics(workId);
    },
    onSuccess: (nextBatchIndex) => {
      setBatchIndex(nextBatchIndex);
      if (workId != null) {
        void queryClient.invalidateQueries({
          queryKey: workKeys.topics(workId, nextBatchIndex),
        });
      }
    },
  });

  const selectMutation = useMutation({
    mutationFn: (topic: Topic) => {
      if (workId == null) throw new Error('没有当前作品');
      return selectTopic(workId, topic.id);
    },
    onSuccess: (_, topic) => {
      setSelectedTopicId(topic.id);
      if (workId != null) void invalidateWork(queryClient, workId);
      if (workId != null) navigate(`/studio/${workId}/script`);
    },
  });

  useEffect(() => {
    if (
      workId != null &&
      materialIds.length > 0 &&
      !requested &&
      envelope.data?.selectedTopicId == null &&
      !generateMutation.isPending
    ) {
      generateMutation.mutate();
    }
  }, [workId, materialIds.length, requested, envelope.data?.selectedTopicId, generateMutation]);

  const workLoading = workId == null && recent.isPending;
  const batch = topicsQuery.data;
  const selectedId = selectedTopicId ?? envelope.data?.selectedTopicId;
  const selectedTopic = batch?.topics.find((topic) => topic.id === selectedId);
  const generateDisabled = selectedTopic == null;
  const generateErrorSource = generateMutation.isError
    ? generateMutation.error
    : topicsQuery.isError
      ? topicsQuery.error
      : null;

  return (
    <section className="topics-page">
      <header className="discover-head">
        <div>
          <h1>选题脑暴</h1>
          <p>选择一个能讲清楚、也值得讲的角度。</p>
        </div>
        <div className="topics-head__meta">
          <Tag color={materialIds.length > 0 ? 'green' : 'orange'}>
            基于素材 {materialIds.length} 条
          </Tag>
          {blankAngle == null ? null : <Tag color="cyan">{blankAngle}</Tag>}
          {batch == null ? null : <Tag>差异校验 {batch.minPairwiseCosine ?? 0}</Tag>}
        </div>
      </header>

      {workLoading || generateMutation.isPending || (shouldFetch && topicsQuery.isPending) ? (
        <LoadingState
          variant="grid"
          label="正在生成选题"
          hint="会根据已收藏素材生成 12 个候选角度"
          testId="topics-loading"
        />
      ) : generateErrorSource != null ? (
        <ErrorState
          error={apiErrorOf(generateErrorSource) ?? undefined}
          title="选题没有生成"
          description="素材与筛选条件仍保留，可以直接重试。"
          level="section"
          actions={[
            {
              key: 'retry',
              label: '重试生成',
              primary: true,
              onClick: () => generateMutation.mutate(),
            },
          ]}
          testId="topics-error"
        />
      ) : materialIds.length === 0 && batch == null ? (
        <EmptyState
          title="先收藏素材"
          description="选题会绑定素材依据，先从搜索结果收藏至少一条。"
          level="section"
          actions={[{ key: 'search', label: '去素材搜索', primary: true, href: '/discover' }]}
          testId="topics-empty"
        />
      ) : batch == null ? (
        <EmptyState
          title="还没有选题批次"
          description="可以从当前素材重新生成一批。"
          level="section"
          actions={[
            {
              key: 'generate',
              label: '生成 12 个角度',
              primary: true,
              onClick: () => generateMutation.mutate(),
            },
          ]}
          testId="topics-initial"
        />
      ) : (
        <>
          <div className="topics-grid">
            {batch.topics.map((topic, index) => {
              const active = topic.id === selectedId;
              return (
                <button
                  key={topic.id}
                  type="button"
                  className="topic-card"
                  data-active={active}
                  aria-pressed={active}
                  onClick={() => setSelectedTopicId(topic.id)}
                >
                  <span className="topic-card__ord">角度 {String(index + 1).padStart(2, '0')}</span>
                  <strong>{topic.hook}</strong>
                  <p>{topic.gap}</p>
                  <footer>
                    <Tag>依据 {topic.basisMaterialIds.length} 条</Tag>
                    {active ? <Tag color="green">已选中</Tag> : null}
                  </footer>
                </button>
              );
            })}
          </div>
          <footer className="discover-action-bar">
            <div>
              <strong>{selectedTopic?.hook ?? '尚未选择角度'}</strong>
              <span>选定后解锁口播文案生成</span>
            </div>
            <div>
              <Button onClick={() => rerollMutation.mutate()} loading={rerollMutation.isPending}>
                换一批
              </Button>
              <Button
                type="primary"
                loading={selectMutation.isPending}
                disabled={generateDisabled}
                title={generateDisabled ? '先选择一个角度' : undefined}
                onClick={() => {
                  if (selectedTopic != null) selectMutation.mutate(selectedTopic);
                }}
              >
                生成口播文案
              </Button>
            </div>
          </footer>
        </>
      )}

      {workId != null ? (
        <p className="topics-work">
          当前作品：<Link to={`/studio/${workId}/script`}>{envelope.data?.title ?? workId}</Link>
        </p>
      ) : null}
    </section>
  );
}
