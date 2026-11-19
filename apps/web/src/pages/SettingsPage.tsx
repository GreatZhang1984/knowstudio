import { Alert, Button, Table, Tag, Typography } from 'antd';
import { useLocation } from 'react-router-dom';
import type { MetricName, MetricsResponse } from '@knowstudio/contracts';
import { ErrorState, LoadingState } from '@knowstudio/ui';
import { useMetrics } from '../work/queries';
import { apiErrorOf } from './discover/searchLogic';

const METRIC_LABELS: readonly { key: MetricName; label: string; unit: string }[] = [
  { key: 'g1_e2e_p50', label: 'G1 端到端 P50', unit: '分钟' },
  { key: 'g2_daily_days', label: 'G2 近 14 天发布天数', unit: '天' },
  { key: 'g3_polish_p50', label: 'G3 润色 P50', unit: '分钟' },
  { key: 'g5_adapt_p50', label: 'G5 适配 P50', unit: '分钟' },
  { key: 'g5_platform_coverage', label: 'G5 平台覆盖', unit: '个平台' },
  { key: 'g6_cost_per_work', label: 'G6 单作品成本', unit: '元' },
  { key: 'major_edit_rate', label: '大改率', unit: '%' },
  { key: 'avg_points_per_work', label: '单作品平均点数', unit: '点' },
  { key: 'render_failure_rate', label: '渲染失败率', unit: '%' },
  { key: 'compliance_block_rate', label: '合规阻断率', unit: '%' },
  { key: 'north_star_within_60m', label: '60 分钟内完成占比', unit: '%' },
];

const TASK_LABELS: Record<NonNullable<MetricsResponse['task']>['status'], string> = {
  idle: '未调度',
  queued: '排队中',
  running: '聚合中',
  retry_scheduled: '等待重试',
  succeeded: '成功',
  failed: '失败',
  canceled: '已取消',
};

const DATA_STATUS_LABELS: Record<MetricsResponse['dataStatus'], string> = {
  missing: '无快照',
  partial: '口径缺失',
  stale: '已过期',
  fresh: '实时',
};

function valueOf(data: MetricsResponse | undefined, metric: MetricName, unit: string): string {
  const item = data?.items.find((candidate) => candidate.metric === metric);
  if (item === undefined || item.value === null) return '—';
  const value =
    unit === '%'
      ? `${(item.value * 100).toFixed(1)}%`
      : unit === '元'
        ? item.value.toFixed(2)
        : item.value.toString();
  return unit === '' || unit === '%' ? value : `${value} ${unit}`;
}

export default function SettingsPage() {
  const metrics = useMetrics();
  const location = useLocation();

  if (metrics.isLoading) return <LoadingState label="指标读取中" />;
  if (metrics.isError) {
    const apiError = apiErrorOf(metrics.error);
    return (
      <ErrorState
        error={apiError ?? undefined}
        title={apiError == null ? '指标暂不可用' : undefined}
        description={apiError == null ? '请稍后重新读取。' : undefined}
        level="page"
        context={{ returnTo: location.pathname }}
      />
    );
  }

  return (
    <section className="settings-page">
      <header className="discover-head">
        <div>
          <Typography.Title level={2}>指标看板</Typography.Title>
          <p>
            {metrics.data?.fresh === true
              ? `快照时间：${metrics.data.generatedAt?.toLocaleString() ?? '—'}`
              : '快照缺失或过期，以下空值不以旧值冒充'}
          </p>
          <p>
            最近聚合：
            {metrics.data?.task === null || metrics.data?.task === undefined
              ? '未调度'
              : `${TASK_LABELS[metrics.data.task.status]} · ${metrics.data.task.bucket.toLocaleString()} · ${
                  metrics.data.task.durationMs === null
                    ? '耗时 —'
                    : `耗时 ${metrics.data.task.durationMs}ms`
                }`}
          </p>
        </div>
        <Tag color={metrics.data?.fresh === true ? 'green' : 'orange'}>
          {metrics.data === undefined ? '待刷新' : DATA_STATUS_LABELS[metrics.data.dataStatus]}
        </Tag>
        <Button href="/settings/sources">素材源配置</Button>
      </header>
      {metrics.data?.task?.lastError !== null && metrics.data?.task?.lastError !== undefined ? (
        <Alert
          type={metrics.data.task.status === 'failed' ? 'error' : 'warning'}
          showIcon
          message={`指标聚合${TASK_LABELS[metrics.data.task.status]}`}
          description={`${metrics.data.task.lastError.code}: ${metrics.data.task.lastError.message}`}
          style={{ marginBottom: 16 }}
        />
      ) : null}
      <Alert
        type="info"
        showIcon
        message="G4 盲测结果需人工录入"
        description="当前看板不自动推断盲测辨识率。"
      />
      <Table
        size="middle"
        rowKey="key"
        pagination={false}
        dataSource={METRIC_LABELS}
        columns={[
          { title: '指标', dataIndex: 'label' },
          {
            title: '当前值',
            render: (_, row) => valueOf(metrics.data, row.key, row.unit),
          },
          {
            title: '样本数',
            render: (_, row) =>
              metrics.data?.items.find((item) => item.metric === row.key)?.sampleN ?? '—',
          },
        ]}
      />
    </section>
  );
}
