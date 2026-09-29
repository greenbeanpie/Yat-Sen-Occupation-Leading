// PLAN.md 第 5 节：离线编辑后刷新仍保留内容，恢复网络后提交。
// 需要带 Service Worker 的生产构建，例如：
//   npx wrangler dev -c frontend/wrangler.jsonc -c backend/wrangler.jsonc --port 8790
//   cd frontend && npm run build
//   WORKBENCH_URL=http://127.0.0.1:8790 npm run e2e:offline
import { chromiumExecutable, loadPlaywright } from './playwright-runtime.mjs';

const playwright = await loadPlaywright();
const { chromium } = playwright;
const BASE = process.env.WORKBENCH_URL ?? 'http://127.0.0.1:8790';
const RUN = Date.now().toString(36);

const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` :: ${detail}` : ''}`);
};
const step = async (name, body) => {
  try {
    record(name, true, (await body()) ?? '');
  } catch (error) {
    record(name, false, error instanceof Error ? error.message.split('\n')[0] : String(error));
  }
};

const browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const goNav = async (label) => page.getByRole('link', { name: new RegExp(`^${label}`) }).first().click();

await page.goto(BASE, { waitUntil: 'networkidle' });

await step('准备：登录并等待 Service Worker 接管页面', async () => {
  await page.getByRole('button', { name: /演示学生/ }).first().click();
  await page.locator('.who').waitFor({ state: 'visible', timeout: 20000 });
  const controlled = await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    return Boolean(navigator.serviceWorker.controller);
  });
  if (!controlled) throw new Error('页面尚未被 Service Worker 接管');
  return '外壳已缓存';
});

const offlineValue = `离线待同步岗位 ${RUN}`;
await step('离线：断网后保存画像进入本机队列', async () => {
  await goNav('画像与证据');
  await page.getByText('你的求职画像').first().waitFor({ state: 'visible', timeout: 20000 });
  const form = page.locator('form.form-grid').first();
  await form.getByLabel('目标岗位（逗号分隔）').fill(offlineValue);
  await context.setOffline(true);
  await form.getByRole('button', { name: '保存画像' }).click();
  await page.getByText(/已写入本机队列/).first().waitFor({ state: 'visible', timeout: 20000 });
  return '已入队';
});

await step('离线刷新：外壳从 Service Worker 加载并保留本机内容', async () => {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.who').waitFor({ state: 'visible', timeout: 30000 });
  await goNav('画像与证据');
  await page.getByText('你的求职画像').first().waitFor({ state: 'visible', timeout: 20000 });
  const value = await page.locator('form.form-grid').first().getByLabel('目标岗位（逗号分隔）').inputValue();
  if (!value.includes(RUN)) throw new Error(`刷新后未保留离线修改：${value}`);
  const pending = await page.locator('.sync-pill').first().innerText();
  return `表单值已保留，${pending.trim()}`;
});

await step('恢复网络：同步队列提交离线修改', async () => {
  await goNav('设置与同步');
  await page.getByText('同步、提醒与离线状态').first().waitFor({ state: 'visible', timeout: 20000 });
  await context.setOffline(false);
  await page.locator('section.panel').filter({ has: page.getByRole('heading', { name: '离线同步', exact: true }) })
    .getByRole('button', { name: '立即同步' }).click();
  await page.getByText(/同步完成：/).first().waitFor({ state: 'visible', timeout: 30000 });
  const summary = (await page.getByText(/同步完成：/).first().innerText()).trim();
  if (!/0 项待提交/.test(summary)) throw new Error(`队列未清空：${summary}`);
  return summary;
});

await browser.close();
const failed = results.filter((result) => !result.ok);
console.log(`\n通过 ${results.length - failed.length}/${results.length}`);
process.exit(failed.length ? 1 : 0);
