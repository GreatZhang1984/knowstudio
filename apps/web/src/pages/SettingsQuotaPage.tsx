import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Alert, Button, Card, Input, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { ErrorState, LoadingState } from '@knowstudio/ui';
import { fetchLedger } from '../work/api';
import { useQuota, workKeys } from '../work/queries';
import { QuotaBar } from '../layout/Quota';

const ACTION_LABELS: Record<string, string> = {
  grant: '发放',
  reserve: '预扣',
  commit: '消耗',
  release: '释放',
  reset: '重置',
  adjust: '调整',
};

const columns: ColumnsType<{
  id: number;
  createdAt: string;
  action: string;
  points: number;
  balanceAfter: number;
  workId: string | null;
  note: string | null;
}> = [
  { title: '时间', dataIndex: 'createdAt', render: (value: string) => value.slice(0, 19).replace('T', ' ') },
  {
    title: '动作',
    dataIndex: 'action',
    render: (value: string) => <Tag>{ACTION_LABELS[value] ?? value}</Tag>,
  },
  { title: '点数', dataIndex: 'points', align: 'right' },
  { title: '剩余', dataIndex: 'balanceAfter', align: 'right' },
  { title: '作品', dataIndex: 'workId', render: (value: string | null) => value ?? '-' },
  { title: '说明', dataIndex: 'note', render: (value: string | null) => value ?? '-' },
];

export default function SettingsQuotaPage() {
  const currentMonth = new Date().toISOString().slice(0, 7);
  const [month, setMonth] = useState(currentMonth);
  const quota = useQuota();
  const ledger = useInfiniteQuery({
    queryKey: workKeys.ledger(month),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => fetchLedger({ month, cursor: pageParam }),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

  if (quota.isPending) return <LoadingState variant="list" label="正在读取额度" />;
  if (quota.isError) {
    return (
      <ErrorState
        title="额度暂时读不到"
        description="渲染不受影响，稍后可以重新读取。"
        actions={[{ key: 'retry', label: '重试', primary: true, onClick: () => void quota.refetch() }]}
      />
    );
  }

  return (
    <section className="quota-page">
      <header className="discover-head">
        <div>
          <h1>配额与成本</h1>
          <p>额度、预扣与账本使用同一份服务端数据。</p>
        </div>
        <Input aria-label="选择月份" type="month" value={month} onChange={(event) => setMonth(event.target.value)} />
      </header>

      <div className="quota-page__summary">
        <Card size="small" title="当前额度">
          <QuotaBar />
        </Card>
        <Card size="small" title="计价">
          <p>草稿渲染 0 点</p>
          <p>高清渲染 2 点</p>
          <p>月度额度 {quota.data?.total ?? 0} 点</p>
        </Card>
        <Card size="small" title="额度不足时">
          <p>可等待月度重置：{quota.data?.resetAt.slice(0, 10) ?? '-'}</p>
          <p>可先生成 0 点草稿检查节奏。</p>
        </Card>
      </div>

      {ledger.isPending ? (
        <LoadingState variant="text" label="正在读取账本" />
      ) : ledger.isError ? (
        <ErrorState
          title="账本暂时读不到"
          description="额度数字仍可用，稍后可以重新读取明细。"
          actions={[{ key: 'retry', label: '重试', primary: true, onClick: () => void ledger.refetch() }]}
        />
      ) : (
        <>
          <Table
            rowKey="id"
            size="small"
            columns={columns}
            dataSource={ledger.data.pages.flatMap((page) => page.items)}
            pagination={false}
          />
          {ledger.hasNextPage ? (
            <Button block loading={ledger.isFetchingNextPage} onClick={() => void ledger.fetchNextPage()}>
              加载更多
            </Button>
          ) : (
            <Alert type="info" showIcon message={`本月共 ${ledger.data.pages[0]?.total ?? 0} 条记录`} />
          )}
        </>
      )}
    </section>
  );
}
