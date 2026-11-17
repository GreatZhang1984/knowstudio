import { Card } from 'antd';
import { Link } from 'react-router-dom';
import { PageStub } from './PageStub';

export default function LoginPage() {
  return (
    <div className="bare-page">
      <Card>
        <PageStub pageId="page-login" title="登录" note="登录表单与 Bearer 鉴权由 T-06 交付；本页不套工作台外壳。">
          <Link to="/">先进工作台看看</Link>
        </PageStub>
      </Card>
    </div>
  );
}