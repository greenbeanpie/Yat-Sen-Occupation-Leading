import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
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

/** 各平台 Chromium 可执行文件的相对布局（目录名按缓存里的实际版本号解析）。 */
function platformLayouts() {
  switch (process.platform) {
    case 'win32':
      return [
        ['chromium-', 'chrome-win64/chrome.exe'],
        ['chromium-', 'chrome-win/chrome.exe'],
        ['chromium_headless_shell-', 'chrome-headless-shell-win64/chrome-headless-shell.exe'],
      ];
    case 'darwin':
      return [
        ['chromium-', 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'],
        ['chromium_headless_shell-', 'chrome-headless-shell-mac-arm64/chrome-headless-shell'],
      ];
    default:
      return [
        ['chromium-', 'chrome-linux/chrome'],
        ['chromium_headless_shell-', 'chrome-headless-shell-linux/chrome-headless-shell'],
      ];
  }
}

export function chromiumExecutable() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  const caches = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'ms-playwright') : '',
    path.join(home, 'Library/Caches/ms-playwright'),
    path.join(home, '.cache/ms-playwright'),
  ].filter(Boolean);
  for (const cache of caches) {
    if (!existsSync(cache)) continue;
    const versions = readdirSync(cache);
    for (const [prefix, layout] of platformLayouts()) {
      // 版本号不写死：优先完整 Chromium，其次 headless shell。
      for (const entry of versions.filter((name) => name.startsWith(prefix)).sort().reverse()) {
        const full = path.join(cache, entry, layout);
        if (existsSync(full)) return full;
      }
    }
  }
  throw new Error(`未找到 Chromium；请设置 CHROMIUM_PATH（已检查：${caches.join('、')}）。`);
}

export const BASE_URL = process.env.WORKBENCH_URL ?? 'http://127.0.0.1:5173';
