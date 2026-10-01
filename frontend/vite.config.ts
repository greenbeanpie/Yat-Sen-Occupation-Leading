import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = fileURLToPath(new URL('./src/', import.meta.url));
const fingerprint = createHash('sha256');
for (const file of readdirSync(sourceRoot, { recursive: true }).map(String).sort().filter(file => /\.(tsx?|css)$/.test(file) && !file.includes('.test.'))) {
  fingerprint.update(file); fingerprint.update(readFileSync(join(sourceRoot, file)));
}
const buildId = process.env.VITE_BUILD_ID || fingerprint.digest('hex').slice(0, 12);

export default defineConfig({
  define: { 'import.meta.env.VITE_BUILD_ID': JSON.stringify(buildId) },
  plugins: [
    react(),
    VitePWA({
      // 由 src/pwa.ts 手动注册，才能在界面上给出“新版本已就绪”的提示。
      registerType: 'prompt',
      injectRegister: null,
      includeAssets: ['favicon.svg', 'icons/workbench.svg', 'icons/workbench-192.png', 'icons/workbench-512.png', 'icons/workbench-maskable-512.png'],
      manifest: {
        name: '实习决策与执行工作台',
        short_name: '实习工作台',
        description: '学生求职任务与投递管理工作台',
        theme_color: '#f3f5f9',
        background_color: '#f3f5f9',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/icons/workbench-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/workbench-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icons/workbench-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: '/icons/workbench.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        navigateFallback: 'index.html',
        importScripts: ['/asset-compat.js', '/push-worker.js'],
        runtimeCaching: [{
          urlPattern: ({ url, sameOrigin }) => sameOrigin && /^\/assets\/[^/]+-[A-Za-z0-9_-]+\.(?:js|css)$/.test(url.pathname),
          handler: 'CacheFirst',
          options: { cacheName: 'intern-workbench-assets-compat-v1', cacheableResponse: { statuses: [200] }, expiration: { maxEntries: 64, maxAgeSeconds: 7 * 24 * 60 * 60 } },
        }],
        cleanupOutdatedCaches: true,
        // Keep activation manual; only a confirmed update claims the existing tabs.
        skipWaiting: false,
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
