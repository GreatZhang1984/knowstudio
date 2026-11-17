import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Input, Select, Tag } from 'antd';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { LicenseState, MaterialType } from '@knowstudio/contracts';
import { EmptyState, ErrorState, LoadingState } from '@knowstudio/ui';
import { fetchLibrary, replaceMaterial } from '../work/api';
import { workKeys } from '../work/queries';
import { licenseLabel } from './discover/searchLogic';

const TYPE_OPTIONS = [
  { value: 'knowledge', label: '知识' },
  { value: 'hot', label: '热点' },
  { value: 'peer', label: '同行' },
  { value: 'image', label: '图片' },
  { value: 'doc', label: '文档' },
  { value: 'music', label: '音乐' },
  { value: 'font', label: '字体' },
];

const LICENSE_OPTIONS = [
  { value: 'cleared', label: '可商用' },
  { value: 'restricted', label: '需授权' },
  { value: 'unknown', label: '授权未知' },
];

const TYPE_LABEL: Record<MaterialType, string> = {
  knowledge: '知识',
  hot: '热点',
  peer: '同行',
  image: '图片',
  doc: '文档',
  music: '音乐',
  font: '字体',
};

export default function LibraryPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [q, setQ] = useState('');
  const [type, setType] = useState<MaterialType | undefined>();
  const [license, setLicense] = useState<LicenseState | undefined>();
  const query = useQuery({
    queryKey: workKeys.library(q, type, license),
    queryFn: () => fetchLibrary({ ...(q === '' ? {} : { q }), type, license }),
  });
  const materials = query.data?.items ?? [];
  const replacementWorkId = searchParams.get('work') ?? '';
  const replacementMaterialId = searchParams.get('replace') ?? '';
  const replacing = replacementWorkId !== '' && replacementMaterialId !== '';
  const replace = useMutation({
    mutationFn: (materialId: string) =>
      replaceMaterial(replacementWorkId, replacementMaterialId, materialId),
    onSuccess: (response) => {
      queryClient.setQueryData(workKeys.envelope(replacementWorkId), response.envelope);
      navigate(`/publish/${replacementWorkId}`);
    },
  });

  return (
    <section className="library-page">
      <header className="discover-head">
        <div>
          <h1>素材库</h1>
          <p>{query.data == null ? '正在读取素材' : `共 ${query.data.total} 条可见素材`}</p>
        </div>
      </header>
      {replacing ? (
        <Alert
          type="info"
          showIcon
          message="选择一个同类型素材替换当前阻断素材"
          action={
            <Button
              size="small"
              onClick={() => {
                searchParams.delete('work');
                searchParams.delete('replace');
                setSearchParams(searchParams);
              }}
            >
              取消替换
            </Button>
          }
        />
      ) : null}

      <form
        className="library-filter"
        onSubmit={(event) => {
          event.preventDefault();
          void query.refetch();
        }}
      >
        <Input
          value={q}
          maxLength={100}
          aria-label="搜索素材标题"
          placeholder="搜索素材标题"
          allowClear
          onChange={(event) => setQ(event.target.value)}
        />
        <Select
          value={type}
          options={TYPE_OPTIONS}
          placeholder="全部类型"
          allowClear
          aria-label="素材类型"
          onChange={(value) => setType(value as MaterialType | undefined)}
        />
        <Select
          value={license}
          options={LICENSE_OPTIONS}
          placeholder="全部授权"
          allowClear
          aria-label="授权状态"
          onChange={(value) => setLicense(value as LicenseState | undefined)}
        />
        <Button htmlType="submit" loading={query.isFetching}>
          筛选
        </Button>
      </form>

      {query.isPending ? (
        <LoadingState variant="grid" label="正在读取素材库" testId="library-loading" />
      ) : query.isError ? (
        <ErrorState
          title="素材库暂时读不到"
          description="筛选条件都保留着，稍后可以重试。"
          level="section"
          actions={[
            { key: 'retry', label: '重试', primary: true, onClick: () => void query.refetch() },
          ]}
          testId="library-error"
        />
      ) : materials.length === 0 ? (
        <EmptyState
          title="没有匹配的素材"
          description="换个标题关键词，或放宽类型与授权筛选。"
          level="section"
          actions={[
            {
              key: 'clear',
              label: '清空筛选',
              primary: true,
              onClick: () => {
                setQ('');
                setType(undefined);
                setLicense(undefined);
              },
            },
          ]}
          testId="library-empty"
        />
      ) : (
        <div className="library-grid">
          {materials.map((material) => (
            <article className="library-card" key={material.id} data-material-id={material.id}>
              <header>
                <span>{material.source}</span>
                <Tag data-license={material.license}>{licenseLabel(material.license)}</Tag>
              </header>
              <h3>{material.title}</h3>
              <p>{material.summary === '' ? '暂无摘要。' : material.summary}</p>
              <footer>
                <Tag>{TYPE_LABEL[material.type]}</Tag>
                {material.collected ? <strong>已收藏</strong> : <span>未收藏</span>}
                {replacing ? (
                  <Button
                    size="small"
                    loading={replace.isPending}
                    disabled={material.id === replacementMaterialId}
                    onClick={() => replace.mutate(material.id)}
                  >
                    替换为此素材
                  </Button>
                ) : null}
              </footer>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
