import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Alert, Button, Tag } from 'antd';
import { useParams } from 'react-router-dom';
import type { ExportFile, PlatformId } from '@knowstudio/contracts';
import { ErrorState, G5_EXPORT_NOTICE, LoadingState } from '@knowstudio/ui';
import { createExport, fetchExportPackage } from '../work/api';
import { useWorkEnvelope, workKeys } from '../work/queries';
import { apiErrorOf } from './discover/searchLogic';

const PLATFORM_LABEL: Record<PlatformId, string> = {
  douyin: '抖音',
  sph: '视频号',
  bili: 'B站',
  xhs: '小红书',
};

const COMPLIANCE_LABEL: Record<'image' | 'music' | 'font' | 'content', string> = {
  image: '图片授权',
  music: '音乐授权',
  font: '字体授权',
  content: '文案与平台内容',
};

function fileOf(files: readonly ExportFile[], kind: ExportFile['kind']): ExportFile | undefined {
  return files.find((file) => file.kind === kind);
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

export default function ExportPage() {
  const { id } = useParams();
  const workId = id ?? '';
  const envelope = useWorkEnvelope(workId);
  const [exportId, setExportId] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => createExport(workId),
    onSuccess: (accepted) => setExportId(accepted.exportId),
  });
  const exportPackage = useQuery({
    queryKey: workKeys.exportPackage(workId, exportId ?? ''),
    queryFn: () => fetchExportPackage(exportId ?? ''),
    enabled: exportId != null,
    refetchInterval: (query) =>
      query.state.data?.status === 'queued' || query.state.data?.status === 'running'
        ? 1000
        : false,
  });

  if (envelope.isPending) return <LoadingState variant="list" label="正在读取导出信息" />;
  if (envelope.isError || envelope.data == null) {
    return (
      <ErrorState
        title="导出信息暂时读不到"
        description="稍后可以重试，作品和已生成的素材不会丢失。"
        actions={[
          { key: 'retry', label: '重试', primary: true, onClick: () => void envelope.refetch() },
        ]}
      />
    );
  }

  const createApiError = apiErrorOf(create.error);

  if (create.isPending) {
    return <LoadingState variant="list" label="正在复核合规并创建导出任务" />;
  }

  if (createApiError?.code === 'COMPLIANCE_BLOCKED') {
    return (
      <section className="export-page">
        <header className="discover-head">
          <div>
            <h1>导出被合规阻断</h1>
            <p>{envelope.data.title}</p>
          </div>
          <Button type="primary" href={`/publish/${workId}`}>
            去修复合规
          </Button>
        </header>
        <div className="export-blocked">
          {createApiError.details.blockingItems.map((item) => (
            <Alert
              key={`${item.kind}:${item.detail}`}
              type="error"
              showIcon
              message={COMPLIANCE_LABEL[item.kind]}
              description={
                <div>
                  <p>{item.detail}</p>
                  {item.fixHint == null ? null : <p>{item.fixHint}</p>}
                  {item.materialIds.map((materialId) => (
                    <Button key={materialId} href={`/library?work=${workId}&replace=${materialId}`}>
                      替换 {materialId}
                    </Button>
                  ))}
                </div>
              }
            />
          ))}
        </div>
      </section>
    );
  }

  if (create.isError) {
    return (
      <ErrorState
        error={createApiError ?? undefined}
        title="导出任务创建失败"
        description="稍后可以重试；平台媒体与合规报告不会因此丢失。"
        actions={[{ key: 'retry', label: '重试', primary: true, onClick: () => create.mutate() }]}
      />
    );
  }

  if (exportId == null) {
    return (
      <section className="export-page">
        <header className="discover-head">
          <div>
            <h1>导出打包</h1>
            <p>{envelope.data.title}</p>
          </div>
          <Button type="primary" onClick={() => create.mutate()}>
            开始导出打包
          </Button>
        </header>
        <div className="export-panel">
          <Alert
            type="success"
            showIcon
            message={G5_EXPORT_NOTICE}
            description="导出后由你本人登录各平台发布。"
          />
          <p>导出前会再次执行合规复检，并检查四平台成片与封面。</p>
        </div>
      </section>
    );
  }

  if (exportPackage.isPending) {
    return <LoadingState variant="list" label="正在读取导出任务" />;
  }
  if (exportPackage.isError) {
    return (
      <ErrorState
        title="导出任务暂时读不到"
        description="任务可能仍在执行，稍后可以重试读取。"
        actions={[
          { key: 'retry', label: '重试', primary: true, onClick: () => void exportPackage.refetch() },
        ]}
      />
    );
  }

  const pkg = exportPackage.data;
  if (pkg.status === 'queued' || pkg.status === 'running') {
    return <LoadingState variant="list" label="正在打包四平台素材" hint={pkg.status} />;
  }
  if (pkg.status !== 'succeeded') {
    return (
      <ErrorState
        title="导出打包失败"
        description="可以重新发起导出；已生成的平台素材不会被删除。"
        actions={[
          {
            key: 'restart',
            label: '重新导出',
            primary: true,
            onClick: () => {
              setExportId(null);
              create.mutate();
            },
          },
        ]}
      />
    );
  }

  const packageFile = fileOf(pkg.files, 'package');
  const manifestFile = fileOf(pkg.files, 'manifest');
  const checklistFile = fileOf(pkg.files, 'checklist');
  const platformIds: PlatformId[] = ['douyin', 'sph', 'bili', 'xhs'];

  return (
    <section className="export-page">
      <header className="discover-head">
        <div>
          <h1>导出完成</h1>
          <p>{envelope.data.title}</p>
        </div>
        <div className="export-panel__actions">
          {packageFile == null ? null : (
            <Button type="primary" href={packageFile.url} download={packageFile.path}>
              下载 ZIP 包
            </Button>
          )}
          <Button href={`/publish/${workId}`}>回派生页</Button>
        </div>
      </header>

      <div className="export-panel">
        <Alert
          type="success"
          showIcon
          message={G5_EXPORT_NOTICE}
          description="导出后由你本人登录各平台发布。"
        />
        <dl className="export-meta">
          <div>
            <dt>导出包</dt>
            <dd>{pkg.id}</dd>
          </div>
          <div>
            <dt>合规报告</dt>
            <dd>{pkg.reportId ?? '-'}</dd>
          </div>
          <div>
            <dt>链接有效期</dt>
            <dd>{new Date(pkg.expiresAt).toLocaleString()}</dd>
          </div>
        </dl>
        <div className="export-docs">
          {manifestFile == null ? null : (
            <Button href={manifestFile.url} download={manifestFile.path}>
              manifest.json
            </Button>
          )}
          {checklistFile == null ? null : (
            <Button href={checklistFile.url} download={checklistFile.path}>
              发布清单.md
            </Button>
          )}
        </div>
      </div>

      <div className="export-platforms">
        {platformIds.map((platformId) => {
          const video = pkg.files.find(
            (file) => file.platformId === platformId && file.kind === 'video',
          );
          const cover = pkg.files.find(
            (file) => file.platformId === platformId && file.kind === 'cover',
          );
          return (
            <article key={platformId} className="export-platform">
              <header>
                <strong>{PLATFORM_LABEL[platformId]}</strong>
                <Tag>{formatBytes((video?.bytes ?? 0) + (cover?.bytes ?? 0))}</Tag>
              </header>
              {video == null ? null : (
                <Button href={video.url} download={video.path}>
                  下载成片
                </Button>
              )}
              {cover == null ? null : (
                <Button href={cover.url} download={cover.path}>
                  下载封面
                </Button>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
