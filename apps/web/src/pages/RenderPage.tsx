import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Progress, Tag } from 'antd';
import { useParams, useSearchParams } from 'react-router-dom';
import { EmptyState, ErrorState, LoadingState } from '@knowstudio/ui';
import { cancelRenderJob, fetchRenderJob, retryRenderJob } from '../work/api';
import { invalidateQuota, invalidateWork, useWorkEnvelope, workKeys } from '../work/queries';

export default function RenderPage() {
  const { id } = useParams();
  const workId = id ?? '';
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const envelope = useWorkEnvelope(workId);
  const jobId = searchParams.get('job') ?? envelope.data?.activeRenderJobId ?? null;
  const job = useQuery({
    queryKey: workKeys.job(workId, jobId ?? ''),
    queryFn: () => fetchRenderJob(jobId ?? ''),
    enabled: jobId != null,
    refetchInterval: (query) =>
      query.state.data?.job.status === 'queued' || query.state.data?.job.status === 'running'
        ? 1000
        : false,
  });
  const cancel = useMutation({
    mutationFn: () => cancelRenderJob(jobId ?? ''),
    onSuccess: () => {
      void invalidateWork(queryClient, workId);
      void invalidateQuota(queryClient);
    },
  });
  const retry = useMutation({
    mutationFn: () => retryRenderJob(workId, jobId ?? ''),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: workKeys.job(workId, jobId ?? '') });
      void invalidateWork(queryClient, workId);
      void invalidateQuota(queryClient);
    },
  });

  const jobStatus = job.data?.job.status;
  useEffect(() => {
    if (jobStatus !== 'succeeded' && jobStatus !== 'failed' && jobStatus !== 'canceled') return;
    void invalidateWork(queryClient, workId);
    void invalidateQuota(queryClient);
  }, [jobStatus, queryClient, workId]);

  return (
    <section className="render-page">
      <header className="discover-head">
        <div>
          <h1>渲染中心</h1>
          <p>{envelope.data?.title ?? '当前作品'}</p>
        </div>
        {job.data == null ? null : (
          <div className="script-head__meta">
            <Tag color={job.data.job.status === 'succeeded' ? 'green' : 'processing'}>
              {job.data.job.status}
            </Tag>
            <Tag>{job.data.job.costPoints} 点</Tag>
          </div>
        )}
      </header>

      {jobId == null ? (
        <EmptyState
          title="暂无渲染任务"
          description="可以先回到视频页生成草稿或高清成片。"
          level="section"
          actions={[
            { key: 'video', label: '去视频页', primary: true, href: `/studio/${workId}/video` },
          ]}
        />
      ) : job.isPending ? (
        <LoadingState variant="text" label="正在恢复任务进度" />
      ) : job.isError ? (
        <ErrorState
          title="任务进度暂时读不到"
          description="任务不会因此中断，稍后可以重试读取。"
          actions={[
            { key: 'retry', label: '重试', primary: true, onClick: () => void job.refetch() },
          ]}
        />
      ) : job.data == null ? null : (
        <>
          <div className="render-progress">
            <span>{job.data.job.stage ?? 'queued'}</span>
            <Progress percent={job.data.job.progress} />
          </div>
          <dl className="render-meta">
            <div>
              <dt>任务</dt>
              <dd>{job.data.job.id}</dd>
            </div>
            <div>
              <dt>尝试次数</dt>
              <dd>{job.data.job.attempt}</dd>
            </div>
            <div>
              <dt>消耗点数</dt>
              <dd>{job.data.job.costPoints}</dd>
            </div>
          </dl>
          {job.data.videoUrl == null ? null : (
            <div className="render-video">
              <video controls preload="metadata" src={job.data.videoUrl} />
            </div>
          )}
          <footer className="discover-action-bar">
            <div>
              <strong>{job.data.job.status}</strong>
              <span>离开页面不会取消任务</span>
            </div>
            <div>
              {job.data.job.status === 'failed' ? (
                <Button loading={retry.isPending} onClick={() => retry.mutate()}>
                  重试
                </Button>
              ) : null}
              {job.data.job.status === 'queued' || job.data.job.status === 'running' ? (
                <Button danger loading={cancel.isPending} onClick={() => cancel.mutate()}>
                  取消任务
                </Button>
              ) : null}
              <Button type="primary" href={`/studio/${workId}/video`}>
                回视频页
              </Button>
            </div>
          </footer>
        </>
      )}
    </section>
  );
}
