import { Alert, Button, Space } from 'antd';
import { Link, Navigate } from 'react-router-dom';
import { PageFallback } from '../components/PageFallback';
import { useRecentWork } from '../work/queries';
import { NO_WORK_FALLBACK, domainEntryTarget } from '../work/resume';

/**
 * `/studio` 与 `/publish` 无 [id] 时的落点：最近活跃 Work 的 step 续作路径。
 *
 * 三态齐全，任何一态都不白屏：
 * - loading：骨架（正常情况下 loader 已预取，这一帧几乎不出现）；
 * - 无 Work：domainEntryTarget(null) → `/works`，是真实页面，不会再被重定向回来；
 * - 取数失败：**停在原地**给错误态 + 手动重试 + 去作品列表的出口。
 *   失败时绝不 Navigate——那会把「取数失败」变成「反复重定向」的死循环。
 */
export function DomainEntryRedirect() {
  const { isPending, isError, error, data, refetch } = useRecentWork();

  if (isPending) return <PageFallback />;

  if (isError) {
    return (
      <Alert
        type="error"
        showIcon
        message="取不到最近活跃的作品"
        description={error instanceof Error ? error.message : '请稍后重试。'}
        action={
          <Space direction="vertical">
            <Button size="small" onClick={() => void refetch()}>
              重试
            </Button>
            <Link to={NO_WORK_FALLBACK}>去作品列表</Link>
          </Space>
        }
      />
    );
  }

  return <Navigate to={domainEntryTarget(data)} replace />;
}