import { Card } from 'antd';
import { Link } from 'react-router-dom';
import { PageStub } from './PageStub';

export default function WelcomePage() {
  return (
    <div className="bare-page">
      <Card>
        <PageStub pageId="page-welcome" title="首次引导" note="引导流程 /welcome → /settings/style → / 待排期（P1）。">
          <Link to="/settings/style">去上传风格样本</Link>
        </PageStub>
      </Card>
    </div>
  );
}