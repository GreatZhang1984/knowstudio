import type { ReactNode } from 'react';
import { Alert } from 'antd';
import { useNavigate, useParams } from 'react-router-dom';
import { GateLocked } from '@knowstudio/ui';
import type { GateId } from '@knowstudio/contracts';
import { PageFallback } from '../components/PageFallback';
import { gateViewOf } from './gateLoader';
import { useWorkEnvelope } from './queries';

/**
 * 深链防护的**组件级兜底**（架构 §5.5）。
 *
 * 正常路径下路由 loader 已经预取过信封，这里首帧读到的就是缓存里的终态，没有中间帧；
 * 但组件被直接挂载（不经 loader）、缓存被清空、或后台重新取数时，它仍要能独立判定。
 * 判定复用 gateViewOf，与 loader 同一段逻辑——两条路径不会判出不同结果。
 *
 * 这里不推导任何闸门布尔值：只读服务端下发的 satisfied / reason / redirectTo。
 */
export function WorkGate({ gate, children }: { gate: GateId; children: ReactNode }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data, isPending, isError, error } = useWorkEnvelope(id);

  if (id == null || id.length === 0) {
    return <Alert type="error" showIcon message="地址里缺少作品 id" description="请从作品列表进入。" />;
  }
  if (isPending) return <PageFallback />;
  if (isError || data == null) {
    return (
      <Alert
        type="error"
        showIcon
        message="取不到作品状态"
        description={error instanceof Error ? error.message : '请稍后重试。'}
      />
    );
  }

  const view = gateViewOf(data, gate);
  if (view.kind === 'locked') {
    return (
      <GateLocked
        requiredGate={view.requiredGate}
        redirectTo={view.redirectTo}
        detail={view.detail}
        onNavigate={(path) => void navigate(path)}
      />
    );
  }

  return <>{children}</>;
}