import { useParams } from 'react-router-dom';
import { PageStub } from './PageStub';

export default function WorkDetailPage() {
  const { id } = useParams();
  return (
    <PageStub
      pageId="page-work-detail"
      title={`作品详情 · ${id ?? ''}`}
      note="阶段进度按 step 续作，不按 stage 直跳（D-03）。"
    />
  );
}