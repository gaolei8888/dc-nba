import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'web',
  // 部署到子路径时用（如 /works/dc-nba/）。构建镜像时由 Dockerfile 的 APP_BASE 传入；
  // 本地开发不设这个变量，退回 "/"，行为和以前完全一样。
  base: process.env.APP_BASE || '/',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:5174' },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
