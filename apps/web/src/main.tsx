import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { KnowStudioThemeProvider } from '@knowstudio/ui';
import '@knowstudio/ui/tokens.css';
import './styles/app.css';
import App from './App';
import { useUiStore } from './store/ui';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false },
  },
});

function ThemedApp({ queryClient }: { queryClient: QueryClient }) {
  const theme = useUiStore((s) => s.theme);
  return (
    <KnowStudioThemeProvider mode={theme}>
      <App queryClient={queryClient} />
    </KnowStudioThemeProvider>
  );
}

const container = document.getElementById('root');
if (container == null) throw new Error('index.html 缺少 #root 挂载点');

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AntApp>
        <ThemedApp queryClient={queryClient} />
      </AntApp>
    </QueryClientProvider>
  </StrictMode>,
);
