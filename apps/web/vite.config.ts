/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // 同域反向代理：开发环境把 /api 转发给 NestJS（统一前缀 /api/v1）。
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
  build: {
    manifest: true,
    target: 'es2022',
    cssMinify: true,
    rollupOptions: {
      output: {
        // Vite 8（Rolldown）使用 codeSplitting.groups 拆分 vendor
        // （旧 manualChunks 对象形式已移除）；业务面板继续按 React.lazy 自动分包。
        codeSplitting: {
          includeDependenciesRecursively: true,
          groups: [
            { name: 'vendor-react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
            { name: 'vendor-router', test: /node_modules[\\/](react-router|@remix-run)[\\/]/ },
            { name: 'vendor-query', test: /node_modules[\\/]@tanstack[\\/]react-query[\\/]/ },
            { name: 'vendor-radix', test: /node_modules[\\/](radix-ui|@radix-ui)[\\/]/ },
            { name: 'vendor-lucide', test: /node_modules[\\/]lucide-react[\\/]/ },
          ],
        },
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
