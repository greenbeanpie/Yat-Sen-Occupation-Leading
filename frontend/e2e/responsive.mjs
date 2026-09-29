// 移动端布局与深链接刷新检查：需要先启动 backend 与 frontend 开发服务器。
// 运行：node e2e/responsive.mjs
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { BASE_URL, chromiumExecutable, loadPlaywright } from './playwright-runtime.mjs';

const playwright = await loadPlaywright();
const { chromium } = playwright;
const EXE = chromiumExecutable();
const BASE = BASE_URL;
const ARTIFACTS = fileURLToPath(new URL('./.artifacts/', import.meta.url));
await mkdir(ARTIFACTS, { recursive: true });
const browser = await chromium.launch({ executablePath: EXE, headless: true });
const results = [];

async function check(name, body) {
  try { results.push([name, true, await body()]); }
  catch (error) { results.push([name, false, error.message.split('\n')[0]]); }
}

// 深链接刷新：直接打开前端路由并 reload
const desktop = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await desktop.goto(`${BASE}/plan`, { waitUntil: 'networkidle' });
await desktop.getByRole('button', { name: /演示学生/ }).first().click();
await desktop.getByText('把组合变成两周行动').first().waitFor({ timeout: 20000 });
await desktop.reload({ waitUntil: 'networkidle' });
await check('深链接刷新 /plan', async () => {
  await desktop.getByText('把组合变成两周行动').first().waitFor({ timeout: 20000 });
  return '重新加载后仍停留在 /plan 并渲染页面';
});

// 移动端视口
const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
await mobile.goto(BASE, { waitUntil: 'networkidle' });
await mobile.getByRole('button', { name: /演示学生/ }).first().click();
await mobile.getByText(/早上好/).first().waitFor({ timeout: 20000 });
await check('移动端底部导航', async () => {
  const nav = await mobile.locator('nav.mobile-bottom-nav').isVisible();
  if (!nav) throw new Error('底部导航未显示');
  return '底部主导航可见';
});

await check('移动端无横向溢出', async () => {
  const overflow = await mobile.evaluate(() => {
    const wide = [...document.querySelectorAll('body *')].filter((node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > window.innerWidth + 1 && rect.width > 0 && getComputedStyle(node).position !== 'fixed';
    }).map((node) => `${node.tagName}.${node.className}`);
    return { scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth, wide: wide.slice(0, 5) };
  });
  if (overflow.scrollWidth > overflow.innerWidth + 1) throw new Error(JSON.stringify(overflow));
  return `scrollWidth=${overflow.scrollWidth} viewport=${overflow.innerWidth}`;
});

const pages = ['/profile', '/jobs', '/match', '/plan', '/applications', '/settings'];
for (const path of pages) {
  await check(`移动端渲染 ${path}`, async () => {
    await mobile.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
    await mobile.locator('h1').first().waitFor({ timeout: 20000 });
    const overflow = await mobile.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
    if (overflow.scrollWidth > overflow.innerWidth + 1) throw new Error(`横向溢出 ${JSON.stringify(overflow)}`);
    return (await mobile.locator('h1').first().innerText()).slice(0, 30);
  });
}
await mobile.goto(`${BASE}/profile`, { waitUntil: 'networkidle' });
await mobile.screenshot({ path: `${ARTIFACTS}mobile-profile.png`, fullPage: false });

for (const [name, ok, detail] of results) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} :: ${detail}`);
const failed = results.filter((r) => !r[1]).length;
console.log(`通过 ${results.length - failed}/${results.length}`);
await browser.close();
process.exit(failed ? 1 : 0);
