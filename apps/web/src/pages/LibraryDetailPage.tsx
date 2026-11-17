import { useParams } from 'react-router-dom';
import { PageStub } from './PageStub';

export default function LibraryDetailPage() {
  const { id } = useParams();
  return (
    <PageStub pageId="page-library-detail" title={`素材详情 · ${id ?? ''}`} note="P1 页面，引用追溯与授权态待排期。" />
  );
}