import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Input, Popconfirm, Select, Tag } from 'antd';
import { useParams } from 'react-router-dom';
import type { ComplianceReport, Derivative, PlatformId } from '@knowstudio/contracts';
import { EmptyState, ErrorState, LoadingState } from '@knowstudio/ui';
import {
  fetchDerivatives,
  fetchCompliance,
  fetchRenderJob,
  fetchPlatformRules,
  generateDerivativeMedia,
  generateDerivativeMetadata,
  patchDerivative,
  regenerateDerivativeTitle,
  collectMaterial,
  attachMaterialLicense,
} from '../work/api';
import { useWorkEnvelope, workKeys } from '../work/queries';
import { trackPublishReceipt } from '../work/observability';

interface DraftDerivative {
  readonly title: string;
  readonly tags: string;
  readonly durationVersion: 'full' | 'essence30' | 'teaser15';
}

const KIND_LABEL: Record<'image' | 'music' | 'font' | 'content', string> = {
  image: '图片授权',
  music: '音乐授权',
  font: '字体授权',
  content: '文案与平台内容',
};

function draftOf(row: Derivative): DraftDerivative {
  return { title: row.title, tags: row.tags.join('，'), durationVersion: row.durationVersion };
}

export default function PublishPage() {
  const { id } = useParams();
  const workId = id ?? '';
  const queryClient = useQueryClient();
  const envelope = useWorkEnvelope(workId);
  const rules = useQuery({ queryKey: workKeys.platformRules, queryFn: fetchPlatformRules });
  const derivatives = useQuery({
    queryKey: workKeys.derivatives(workId),
    queryFn: () => fetchDerivatives(workId),
    enabled: workId.length > 0,
  });
  const [activePlatform, setActivePlatform] = useState<PlatformId>('douyin');
  const [drafts, setDrafts] = useState<Partial<Record<PlatformId, DraftDerivative>>>({});
  const [mediaJobId, setMediaJobId] = useState<string | null>(null);
  const [complianceReport, setComplianceReport] = useState<ComplianceReport | null>(null);
  const [evidenceUrls, setEvidenceUrls] = useState<Record<string, string>>({});
  const [recomputeNotice, setRecomputeNotice] = useState<string | null>(null);
  const [publishedPlatforms, setPublishedPlatforms] = useState<Partial<Record<PlatformId, boolean>>>({});

  useEffect(() => {
    if (derivatives.data == null) return;
    setDrafts(Object.fromEntries(derivatives.data.derivatives.map((row) => [row.platformId, draftOf(row)])));
  }, [derivatives.data]);

  const generate = useMutation({
    mutationFn: () => generateDerivativeMetadata(workId),
    onSuccess: (response) => {
      queryClient.setQueryData(workKeys.derivatives(workId), response);
      queryClient.setQueryData(workKeys.envelope(workId), response.envelope);
    },
  });
  const save = useMutation({
    mutationFn: (platformId: PlatformId) => {
      const draft = drafts[platformId];
      if (draft == null) throw new Error('DERIVATIVE_NOT_FOUND');
      return patchDerivative(workId, platformId, {
        title: draft.title.trim(),
        tags: draft.tags
          .split(/[，,]/u)
          .map((tag) => tag.trim())
          .filter((tag) => tag !== ''),
        durationVersion: draft.durationVersion,
      });
    },
    onSuccess: (response) => {
      queryClient.setQueryData(workKeys.derivatives(workId), response);
      queryClient.setQueryData(workKeys.envelope(workId), response.envelope);
    },
  });
  const regenerate = useMutation({
    mutationFn: (platformId: PlatformId) => regenerateDerivativeTitle(workId, platformId),
    onSuccess: (response) => {
      queryClient.setQueryData(workKeys.envelope(workId), response.envelope);
      void derivatives.refetch();
    },
  });
  const media = useMutation({
    mutationFn: () => generateDerivativeMedia(workId),
    onSuccess: (accepted) => setMediaJobId(accepted.jobId),
  });
  const compliance = useMutation<ComplianceReport, Error, boolean>({
    mutationFn: (force) => fetchCompliance(workId, force),
    onSuccess: (report) => {
      setComplianceReport(report);
      void envelope.refetch();
    },
  });
  const removeMaterial = useMutation({
    mutationFn: (materialId: string) => collectMaterial(workId, materialId, false),
    onSuccess: (response) => {
      queryClient.setQueryData(workKeys.envelope(workId), response.envelope);
      setComplianceReport(null);
      setRecomputeNotice(
        response.patchJob === null
          ? '素材已移除，请重新合规检查。'
          : '素材已移除，课件层重算任务已创建（0 点）。',
      );
    },
  });
  const attachLicense = useMutation({
    mutationFn: ({ materialId, evidenceUrl }: { materialId: string; evidenceUrl: string }) =>
      attachMaterialLicense(workId, materialId, {
        evidenceType: 'commercial_use_grant',
        evidenceUrl,
      }),
    onSuccess: (response) => {
      setComplianceReport(response.report);
      queryClient.setQueryData(workKeys.envelope(workId), response.envelope);
    },
  });
  const mediaJob = useQuery({
    queryKey: workKeys.job(workId, mediaJobId ?? ''),
    queryFn: () => fetchRenderJob(mediaJobId ?? ''),
    enabled: mediaJobId != null,
    refetchInterval: (query) =>
      query.state.data?.job.status === 'queued' || query.state.data?.job.status === 'running'
        ? 1000
        : false,
  });
  const mediaStatus = mediaJob.data?.job.status;
  useEffect(() => {
    if (mediaStatus !== 'succeeded' && mediaStatus !== 'failed' && mediaStatus !== 'canceled') return;
    void derivatives.refetch();
  }, [mediaStatus, derivatives]);

  const rows = useMemo(
    () => new Map((derivatives.data?.derivatives ?? []).map((row) => [row.platformId, row])),
    [derivatives.data],
  );

  if (envelope.isPending || rules.isPending || derivatives.isPending) {
    return <LoadingState variant="list" label="正在读取派生信息" />;
  }
  if (
    envelope.isError ||
    rules.isError ||
    derivatives.isError ||
    envelope.data == null ||
    rules.data == null
  ) {
    return (
      <ErrorState
        title="派生信息暂时读不到"
        description="稍后可以重试，已保存的标题和标签不会丢失。"
        actions={[
          { key: 'retry', label: '重试', primary: true, onClick: () => void derivatives.refetch() },
        ]}
      />
    );
  }

  const sortedRules = ['douyin', 'sph', 'bili', 'xhs']
    .map((platformId) => rules.data.find((rule) => rule.platformId === platformId))
    .filter((rule): rule is NonNullable<typeof rule> => rule !== undefined);
  const currentRule =
    sortedRules.find((rule) => rule.platformId === activePlatform) ?? sortedRules[0];
  const currentRow = currentRule === undefined ? undefined : rows.get(currentRule.platformId);
  const currentDraft = currentRow === undefined ? undefined : drafts[currentRow.platformId];

  return (
    <section className="publish-page">
      <header className="discover-head">
        <div>
          <h1>多平台派生</h1>
          <p>{envelope.data.title}</p>
        </div>
        <div className="script-head__meta">
          <Tag color={envelope.data.gates.G3 ? 'green' : 'orange'}>
            {envelope.data.gates.G3 ? '媒体派生已就绪' : '媒体派生待高清完成'}
          </Tag>
        </div>
      </header>

      {envelope.data.gates.G3 ? null : (
        <Alert
          type="info"
          showIcon
          message="现在可以先编辑标题和标签"
          description="高清视频完成后，这些元数据会直接用于平台媒体派生。"
        />
      )}

      {rows.size === 0 ? (
        <EmptyState
          title="还没有平台标题和标签"
          description="一次生成四个平台的标题、标签和时长版本，之后每个平台都可以单独修改。"
          actions={[
            {
              key: 'generate',
              label: '生成四平台元数据',
              primary: true,
              onClick: () => generate.mutate(),
            },
          ]}
        />
      ) : currentRule == null || currentRow == null || currentDraft == null ? (
        <EmptyState title="平台规则不可用" description="请稍后重新读取平台规则。" level="section" />
      ) : (
        <div className="publish-workbench">
          <nav className="platform-tabs" aria-label="平台">
            {sortedRules.map((rule) => {
              const row = rows.get(rule.platformId);
              const hasBlock = row?.validation.some((item) => item.level === 'block') ?? false;
              return (
                <button
                  key={rule.platformId}
                  type="button"
                  className="platform-tab"
                  aria-pressed={activePlatform === rule.platformId}
                  data-active={activePlatform === rule.platformId}
                  onClick={() => setActivePlatform(rule.platformId)}
                >
                  <span className="platform-dot" style={{ background: rule.brandColor }} />
                  <strong>{rule.name}</strong>
                  <span>
                    {rule.ratio} · {rule.maxDurationSec}s
                  </span>
                  {hasBlock ? <Tag color="error">需修正</Tag> : null}
                </button>
              );
            })}
          </nav>

          <div className="platform-editor">
            <div className="platform-editor__head">
              <div>
                <h2>{currentRule.name}</h2>
                <p>
                  建议标题 ≤{currentRule.titleMax} 字；硬上限 {currentRule.titleHardMax} 字；标签最多{' '}
                  {currentRule.tagMax} 个。
                </p>
              </div>
              <Button loading={regenerate.isPending} onClick={() => regenerate.mutate(activePlatform)}>
                重新生成标题
              </Button>
            </div>

            <label className="field">
              <span>标题</span>
              <Input
                aria-label="标题"
                value={currentDraft.title}
                maxLength={currentRule.titleHardMax}
                showCount
                onChange={(event) =>
                  setDrafts((prev) => ({
                    ...prev,
                    [activePlatform]: { ...currentDraft, title: event.target.value },
                  }))
                }
              />
            </label>
            <label className="field">
              <span>标签（用逗号分隔）</span>
              <Input
                aria-label="标签（用逗号分隔）"
                value={currentDraft.tags}
                onChange={(event) =>
                  setDrafts((prev) => ({
                    ...prev,
                    [activePlatform]: { ...currentDraft, tags: event.target.value },
                  }))
                }
              />
            </label>
            <label className="field">
              <span>时长版本</span>
              <Select
                value={currentDraft.durationVersion}
                options={[
                  { value: 'full', label: '完整版' },
                  { value: 'essence30', label: '精华 30 秒' },
                  { value: 'teaser15', label: '预告 15 秒' },
                ]}
                onChange={(value) =>
                  setDrafts((prev) => ({
                    ...prev,
                    [activePlatform]: { ...currentDraft, durationVersion: value },
                  }))
                }
              />
            </label>

            <div className="derivative-tags">
              {currentRow.tags.map((tag) => (
                <Tag key={tag}>{tag}</Tag>
              ))}
            </div>
            {currentRow.mediaReady && currentRow.mediaUrl != null ? (
              <div className="derivative-media">
                <video controls preload="metadata" src={currentRow.mediaUrl} />
                <span>平台成片已生成</span>
              </div>
            ) : null}
            {currentRow.validation.length === 0 ? null : (
              <div className="derivative-validation">
                {currentRow.validation.map((item) => (
                  <Alert
                    key={`${item.field}:${item.message}`}
                    type={item.level === 'block' ? 'error' : 'warning'}
                    showIcon
                    message={item.message}
                  />
                ))}
              </div>
            )}

            <footer className="discover-action-bar">
              <div>
                <strong>{currentRow.metadataReady ? '元数据已就绪' : '元数据未生成'}</strong>
                <span>当前修改只影响 {currentRule.name}</span>
              </div>
              <div>
                <Button
                  onClick={() => {
                    trackPublishReceipt(workId, activePlatform);
                    setPublishedPlatforms((prev) => ({ ...prev, [activePlatform]: true }));
                  }}
                  disabled={!currentRow.mediaReady || publishedPlatforms[activePlatform] === true}
                >
                  {publishedPlatforms[activePlatform] === true ? '已标记发布' : '标记已发布'}
                </Button>
                <Button loading={save.isPending} type="primary" onClick={() => save.mutate(activePlatform)}>
                  保存当前平台
                </Button>
              </div>
            </footer>
          </div>
        </div>
      )}

      <section className="compliance-panel" aria-label="合规检查">
        <header className="discover-head">
          <div>
            <h2>导出前合规检查</h2>
            <p>
              {complianceReport == null
                ? '检查图片、音乐、字体、文案与平台受限词。'
                : `阻断 ${complianceReport.blockingCount} 项 · 警告 ${complianceReport.warnCount} 项 · ${complianceReport.checkedAt.toLocaleString()}`}
            </p>
          </div>
          <div className="compliance-actions">
            <Button
              loading={compliance.isPending}
              onClick={() => compliance.mutate(complianceReport != null)}
            >
              {complianceReport == null ? '开始合规检查' : '重新复检'}
            </Button>
            <Button
              type="primary"
              disabled={complianceReport == null || complianceReport.blockingCount > 0}
              href={`/publish/${workId}/export`}
            >
              进入导出页
            </Button>
          </div>
        </header>
        {recomputeNotice === null ? null : (
          <Alert type="info" showIcon message={recomputeNotice} />
        )}
        {complianceReport == null ? null : (
          <div className="compliance-items">
            {complianceReport.items.map((item) => (
              <Alert
                key={item.kind}
                type={item.blocking ? 'error' : 'success'}
                showIcon
                message={KIND_LABEL[item.kind]}
                description={
                  <div>
                    <p>{item.detail}</p>
                    {item.fixHint == null ? null : <p>{item.fixHint}</p>}
                    {item.blocking ? (
                      <div className="compliance-fix">
                        {item.materialIds.map((materialId) => (
                          <Button
                            key={`replace:${materialId}`}
                            href={`/library?work=${workId}&replace=${materialId}`}
                          >
                            替换 {materialId}
                          </Button>
                        ))}
                        {item.materialIds.map((materialId) => (
                          <Popconfirm
                            key={`remove:${materialId}`}
                            title="确认移除素材？"
                            description="若素材用于课件，将免费重算课件层（0 点）。"
                            okText="移除"
                            cancelText="取消"
                            onConfirm={() => removeMaterial.mutate(materialId)}
                          >
                            <Button loading={removeMaterial.isPending}>移除 {materialId}</Button>
                          </Popconfirm>
                        ))}
                        {item.materialIds.map((materialId) => (
                          <form
                            key={`license:${materialId}`}
                            className="compliance-license"
                            onSubmit={(event) => {
                              event.preventDefault();
                              const evidenceUrl = evidenceUrls[materialId]?.trim();
                              if (evidenceUrl !== undefined && evidenceUrl !== '') {
                                attachLicense.mutate({ materialId, evidenceUrl });
                              }
                            }}
                          >
                            <Input
                              aria-label={`素材 ${materialId} 授权凭证链接`}
                              placeholder="https://授权凭证链接"
                              value={evidenceUrls[materialId] ?? ''}
                              onChange={(event) =>
                                setEvidenceUrls((prev) => ({
                                  ...prev,
                                  [materialId]: event.target.value,
                                }))
                              }
                            />
                            <Button
                              htmlType="submit"
                              loading={attachLicense.isPending}
                              disabled={(evidenceUrls[materialId] ?? '').trim() === ''}
                            >
                              绑定凭证
                            </Button>
                          </form>
                        ))}
                      </div>
                    ) : null}
                  </div>
                }
              />
            ))}
          </div>
        )}
      </section>

      <footer className="discover-action-bar">
        <div>
          <strong>{envelope.data.gates.G3 ? '高清母版已完成' : '等待高清母版'}</strong>
          <span>媒体文件派生由下一阶段开放</span>
        </div>
        <div>
          <Button href={`/studio/${workId}/render`}>渲染中心</Button>
          <Button
            type="primary"
            disabled={!envelope.data.gates.G3 || media.isPending}
            loading={media.isPending || mediaJob.data?.job.status === 'queued' || mediaJob.data?.job.status === 'running'}
            onClick={() => media.mutate()}
          >
            {mediaJob.data?.job.status === 'queued' || mediaJob.data?.job.status === 'running'
              ? '正在生成平台媒体'
              : '生成平台媒体版本'}
          </Button>
        </div>
      </footer>
      {mediaJob.data == null ? null : (
        <Alert
          type={mediaJob.data.job.status === 'failed' ? 'error' : 'info'}
          showIcon
          message={`平台媒体派生：${mediaJob.data.job.stage ?? 'queued'} ${mediaJob.data.job.progress}%`}
        />
      )}
    </section>
  );
}
