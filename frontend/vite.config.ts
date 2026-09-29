import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // 由 src/pwa.ts 手动注册，才能在界面上给出“新版本已就绪”的提示。
      registerType: 'prompt',
      injectRegister: null,
      includeAssets: ['favicon.svg', 'icons/workbench.svg'],
      manifest: {
        name: '实习决策与执行工作台',
        short_name: '实习工作台',
        description: '学生求职任务与投递管理工作台',
        theme_color: '#f3f5f9',
        background_color: '#f3f5f9',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/icons/workbench.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        navigateFallback: 'index.html',
        runtimeCaching: [],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
      },
    }),
  ],
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api/v1': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
  preview: { host: '127.0.0.1' },
});
