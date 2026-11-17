import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Progress, Tag } from 'antd';
import { useParams } from 'react-router-dom';
import { EmptyState, LoadingState } from '@knowstudio/ui';
import { fetchRenderJob, startRender } from '../work/api';
import { invalidateQuota, invalidateWork, useQuota, useWorkEnvelope, workKeys } from '../work/queries';

export default function VideoPage() {
  const { id } = useParams();
  const workId = id ?? '';
  const queryClient = useQueryClient();
  const envelope = useWorkEnvelope(workId);
  const quota = useQuota();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [currentMs, setCurrentMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const [jobId, setJobId] = useState<string | null>(null);
  const activeJobId = jobId ?? envelope.data?.activeRenderJobId ?? null;
  const job = useQuery({
    queryKey: workKeys.job(workId, activeJobId ?? ''),
    queryFn: () => fetchRenderJob(activeJobId ?? ''),
    enabled: activeJobId != null,
    refetchInterval: (query) =>
      query.state.data?.job.status === 'queued' || query.state.data?.job.status === 'running'
        ? 1000
        : false,
  });

  const render = useMutation({
    mutationFn: (quality: 'draft' | 'hd') => startRender(workId, quality),
    onSuccess: (accepted) => {
      setJobId(accepted.jobId);
      queryClient.setQueryData(workKeys.quota, accepted.quota);
      void queryClient.invalidateQueries({ queryKey: workKeys.job(workId, accepted.jobId) });
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

  if (envelope.isPending) return <LoadingState variant="text" label="正在读取作品状态" />;
  const work = envelope.data;
  if (work == null) {
    return <EmptyState title="找不到作品" description="请从作品列表重新进入。" level="section" />;
  }

  const running = job.data?.job.status === 'queued' || job.data?.job.status === 'running';
  const videoUrl = job.data?.videoUrl ?? null;

  return (
    <section className="video-page">
      <header className="discover-head">
        <div>
          <h1>视频生成</h1>
          <p>{work.title}</p>
        </div>
        <div className="script-head__meta">
          <Tag color={work.gates.G3 ? 'green' : 'orange'}>
            {work.gates.G3 ? 'G3 已解锁' : '待高清渲染'}
          </Tag>
        </div>
      </header>

      {running ? (
        <Alert
          type="info"
          showIcon
          message="正在渲染视频"
          description="可以离开此页，稍后从渲染中心恢复进度。"
          action={
            <Button size="small" href={`/studio/${workId}/render?job=${activeJobId}`}>
              查看进度
            </Button>
          }
        />
      ) : null}

      {job.data != null && running ? (
        <div className="render-progress">
          <span>{job.data.job.stage ?? 'queued'}</span>
          <Progress percent={job.data.job.progress} />
        </div>
      ) : null}

      {videoUrl == null ? (
        <div className="video-actions">
          <Button
            type="primary"
            loading={render.isPending && render.variables === 'draft'}
            onClick={() => render.mutate('draft')}
          >
            生成 480p 草稿 · 0 点
          </Button>
          <Button
            loading={render.isPending && render.variables === 'hd'}
            onClick={() => render.mutate('hd')}
          >
            生成 1080p 高清 · 2 点
          </Button>
        </div>
      ) : (
        <>
          <div className="video-player">
            <video
              ref={videoRef}
              controls
              preload="metadata"
              src={videoUrl}
              onLoadedMetadata={(event) => setDurationMs(event.currentTarget.duration * 1000)}
              onTimeUpdate={(event) => setCurrentMs(event.currentTarget.currentTime * 1000)}
              onDurationChange={(event) => setDurationMs(event.currentTarget.duration * 1000)}
            />
            <div className="video-timeline">
              <span>{(currentMs / 1000).toFixed(1)}s</span>
              <input
                aria-label="视频进度"
                type="range"
                min={0}
                max={Math.max(durationMs, 1)}
                step={100}
                value={Math.min(currentMs, durationMs)}
                onChange={(event) => {
                  const nextMs = Number(event.target.value);
                  setCurrentMs(nextMs);
                  if (videoRef.current !== null) {
                    videoRef.current.currentTime = nextMs / 1000;
                  }
                }}
              />
              <span>{(durationMs / 1000).toFixed(1)}s</span>
            </div>
          </div>
          {work.gates.G3 ? null : (
            <div className="video-actions">
              <Button
                type="primary"
                loading={render.isPending && render.variables === 'hd'}
                onClick={() => render.mutate('hd')}
              >
                生成 1080p 高清 · 2 点
              </Button>
            </div>
          )}
        </>
      )}

      <footer className="discover-action-bar">
        <div>
          <strong>{quota.data?.left ?? work.quota.left} 点可用</strong>
          <span>草稿免费，高清渲染预扣 2 点</span>
        </div>
        <div>
          <Button
            href={`/studio/${workId}/render${activeJobId == null ? '' : `?job=${activeJobId}`}`}
          >
            渲染中心
          </Button>
          <Button
            type="primary"
            disabled={!work.gates.G3}
            href={work.gates.G3 ? `/publish/${workId}` : undefined}
          >
            去平台派生
          </Button>
        </div>
      </footer>
    </section>
  );
}
