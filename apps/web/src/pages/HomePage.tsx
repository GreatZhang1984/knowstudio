import { Card } from 'antd';
import { PageStub } from './PageStub';

export default function HomePage() {
  return (
    <PageStub pageId="page-home" title="工作台首页" note="续作优先于新建；统计卡与热点速览由 T-59/T-60 接真实指标。">
      <div className="page-grid">
        <Card size="small" title="本月产量">
          —
        </Card>
        <Card size="small" title="剩余额度">
          见侧栏额度条
        </Card>
        <Card size="small" title="平均耗时">
          —
        </Card>
      </div>
    </PageStub>
  );
}