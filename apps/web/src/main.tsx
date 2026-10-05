import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';

import '@/styles/app.css';
import App from './App';
import { setupQueryClient } from '@/lib/query';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('未找到 #root 挂载节点');
}

const queryClient = setupQueryClient();

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
