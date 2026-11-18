import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { ErrorState, LoadingState } from '@knowstudio/ui';
import {
  fetchMaterialSourceConfig,
  testMaterialSource,
  updateMaterialSourceConfig,
  type MaterialSourceConfigInput,
} from '../work/api';
import { workKeys } from '../work/queries';
import { SettingsSourcesView } from './settings-sources/SettingsSourcesView';

export default function SettingsSourcesPage() {
  const queryClient = useQueryClient();
  const { message } = AntApp.useApp();
  const config = useQuery({
    queryKey: workKeys.materialSourceConfig,
    queryFn: fetchMaterialSourceConfig,
  });

  const save = useMutation({
    mutationFn: (input: MaterialSourceConfigInput) => updateMaterialSourceConfig(input),
    onSuccess: (next) => {
      queryClient.setQueryData(workKeys.materialSourceConfig, next);
      void queryClient.invalidateQueries({ queryKey: workKeys.materialSources });
      message.success('素材源配置已保存');
    },
    onError: () => {
      message.error('素材源配置保存失败，请检查填写内容');
    },
  });

  const test = useMutation({
    mutationFn: (sourceId: 'web_search' | 'obsidian') => testMaterialSource(sourceId),
    onSuccess: (result) => {
      if (result.ok) message.success('连接成功');
      else message.error(`连接失败：${result.error ?? '未知错误'}`);
      void queryClient.invalidateQueries({ queryKey: workKeys.materialSourceConfig });
    },
  });

  if (config.isPending) return <LoadingState label="正在读取素材源配置" />;
  if (config.isError) {
    return (
      <ErrorState
        title="素材源配置暂时读不到"
        description="稍后可以重新读取；已保存配置不会被清除。"
        actions={[
          { key: 'retry', label: '重试', primary: true, onClick: () => void config.refetch() },
        ]}
      />
    );
  }

  return (
    <SettingsSourcesView
      config={config.data}
      saving={save.isPending}
      testingSourceId={test.isPending ? test.variables : null}
      onSave={(input) => save.mutate(input)}
      onTest={(sourceId) => test.mutate(sourceId)}
    />
  );
}
