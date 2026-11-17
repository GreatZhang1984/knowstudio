import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Input, Tag } from 'antd';
import { EmptyState, ErrorState, LoadingState } from '@knowstudio/ui';
import { createStyleSample, fetchStyleProfile, fetchStyleSamples } from '../work/api';
import { workKeys } from '../work/queries';

export default function SettingsStylePage() {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const samples = useQuery({ queryKey: workKeys.styleSamples(), queryFn: fetchStyleSamples });
  const profile = useQuery({
    queryKey: workKeys.styleProfile(),
    queryFn: fetchStyleProfile,
  });
  const create = useMutation({
    mutationFn: () =>
      createStyleSample({ title: title.trim(), content: content.trim(), source: 'paste' }),
    onSuccess: () => {
      setTitle('');
      setContent('');
      void queryClient.invalidateQueries({ queryKey: workKeys.styleSamples() });
      void queryClient.invalidateQueries({ queryKey: workKeys.styleProfile() });
    },
  });

  return (
    <section className="style-page">
      <header className="discover-head">
        <div>
          <h1>风格样本</h1>
          <p>用你写过的文案，让重写更像你。</p>
        </div>
        <Tag>{profile.data?.sampleCount ?? 0} 篇已学习</Tag>
      </header>

      <form
        className="style-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (title.trim() !== '' && content.trim() !== '') create.mutate();
        }}
      >
        <Input
          value={title}
          maxLength={255}
          aria-label="样本标题"
          placeholder="样本标题"
          onChange={(event) => setTitle(event.target.value)}
        />
        <Input.TextArea
          value={content}
          aria-label="样本正文"
          placeholder="粘贴一篇你写的口播或文章"
          autoSize={{ minRows: 5, maxRows: 10 }}
          onChange={(event) => setContent(event.target.value)}
        />
        <Button htmlType="submit" type="primary" loading={create.isPending}>
          添加样本
        </Button>
      </form>

      {create.isError ? (
        <ErrorState
          title="样本没有保存"
          description="正文仍保留在输入框，稍后重试。"
          level="section"
          testId="style-create-error"
        />
      ) : null}

      {samples.isPending ? (
        <LoadingState variant="list" label="正在读取风格样本" />
      ) : samples.isError ? (
        <ErrorState
          title="风格样本暂时读不到"
          level="section"
          actions={[
            { key: 'retry', label: '重试', primary: true, onClick: () => void samples.refetch() },
          ]}
        />
      ) : samples.data?.length === 0 ? (
        <EmptyState
          title="还没有风格样本"
          description="先添加至少一篇你写的文案；没有样本时文案生成会使用默认风格。"
          level="section"
        />
      ) : (
        <div className="style-list">
          {samples.data?.map((sample) => (
            <article key={sample.id}>
              <header>
                <h2>{sample.title}</h2>
                <Tag>{sample.charCount} 字</Tag>
              </header>
              <p>{sample.status === 'ready' ? '已学习' : '学习失败'}</p>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
