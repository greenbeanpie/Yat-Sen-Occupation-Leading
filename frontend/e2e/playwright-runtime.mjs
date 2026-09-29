import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

/**
 * 浏览器联调脚本使用本机已有的 playwright-core 与 Chromium 缓存，
 * 避免为一个可选检查再引入一份重量级依赖。
 * 可用 PLAYWRIGHT_CORE 与 CHROMIUM_PATH 覆盖。
 */
export async function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_CORE,
    'playwright-core',
    'playwright',
    '/opt/homebrew/lib/node_modules/openclaw/node_modules/playwright-core',
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      // require.resolve 会把目录解析到 package.json 的入口文件，ESM 不能直接导入目录。
      const resolved = require.resolve(candidate);
      const loaded = await import(pathToFileURL(resolved).href);
      const playwright = loaded.default ?? loaded;
      if (playwright.chromium) return playwright;
    } catch {
      // 继续尝试下一个候选路径。
    }
  }
  throw new Error('未找到 playwright-core；请设置 PLAYWRIGHT_CORE 指向其入口文件。');
}

export function chromiumExecutable() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const cache = path.join(process.env.HOME ?? '', 'Library/Caches/ms-playwright');
  const candidates = [
    'chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell',
  ];
  for (const candidate of candidates) {
    const full = path.join(cache, candidate);
    if (existsSync(full)) return full;
  }
  throw new Error(`未找到 Chromium；请设置 CHROMIUM_PATH（缓存目录：${cache}）。`);
}

export const BASE_URL = process.env.WORKBENCH_URL ?? 'http://127.0.0.1:5173';
