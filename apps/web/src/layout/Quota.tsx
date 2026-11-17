import { Skeleton, Tooltip } from 'antd';
import { Link } from 'react-router-dom';
import { useQuota } from '../work/queries';

const pct = (n: number, total: number) => (total === 0 ? 0 : (n / total) * 100);

/** 架构 §11.4 自建模式 5：含预扣的三色分段。侧栏常驻。 */
export function QuotaBar() {
  const { data } = useQuota();

  if (data == null) {
    return <Skeleton active title={false} paragraph={{ rows: 2 }} />;
  }

  const label = `本月额度 ${data.total} 点：已用 ${data.used} 点，预扣 ${data.reserved} 点，剩余 ${data.left} 点`;

  return (
    <div className="quota">
      <div className="quota__head">
        <span>本月额度</span>
        <strong>
          {data.left} / {data.total} 点
        </strong>
      </div>
      <div className="quota__track" role="img" aria-label={label}>
        <span className="quota__seg" data-kind="used" style={{ width: `${pct(data.used, data.total)}%` }} />
        <span
          className="quota__seg"
          data-kind="reserved"
          style={{ width: `${pct(data.reserved, data.total)}%` }}
        />
        <span className="quota__seg" data-kind="left" style={{ width: `${pct(data.left, data.total)}%` }} />
      </div>
      <p className="quota__legend">
        已用 {data.used} · 预扣 {data.reserved} · 剩余 {data.left}
      </p>
    </div>
  );
}

/** 顶栏 pill。与侧栏读同一个 queryKey，数字不可能不一致（AC-H3）。 */
export function QuotaPill() {
  const { data } = useQuota();
  const text = data == null ? '— 点' : `${data.left} 点`;
  const tip =
    data == null
      ? '额度加载中'
      : `已用 ${data.used} · 预扣 ${data.reserved} · 剩余 ${data.left} / ${data.total}`;

  return (
    <Tooltip title={tip}>
      <Link className="quota-pill" to="/settings/quota" aria-label={`剩余额度 ${text}，查看配额与成本`}>
        {text}
      </Link>
    </Tooltip>
  );
}