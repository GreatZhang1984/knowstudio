import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { useLocation } from 'react-router-dom';
import { ErrorState, LoadingState } from '@knowstudio/ui';
import {
  fetchMaterialSourceConfig,
  testMaterialSource,
  updateMaterialSourceConfig,
  type MaterialSourceConfigInput,
} from '../work/api';
import { workKeys } from '../work/queries';
import { apiErrorOf } from './discover/searchLogic';
import { SettingsSourcesView } from './settings-sources/SettingsSourcesView';

export default function SettingsSourcesPage() {
  const queryClient = useQueryClient();
  const { message } = AntApp.useApp();
  const location = useLocation();
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
    const apiError = apiErrorOf(config.error);
    return (
      <ErrorState
        error={apiError ?? undefined}
        title={apiError == null ? '素材源配置暂时读不到' : undefined}
        description={apiError == null ? '稍后可以重新读取；已保存配置不会被清除。' : undefined}
        level="page"
        context={{ returnTo: location.pathname }}
        actions={
          apiError == null
            ? [{ key: 'retry', label: '重试', primary: true, onClick: () => void config.refetch() }]
            : undefined
        }
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
