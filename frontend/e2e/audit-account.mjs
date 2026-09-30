import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadPlaywright, chromiumExecutable } from './playwright-runtime.mjs';
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true });
const dir = fileURLToPath(new URL('./.artifacts/account/', import.meta.url));
await mkdir(dir, { recursive: true });
const results = [];
for (const width of [1440, 390, 320]) for (const theme of ['light', 'dark']) {
 const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme });
 await context.addInitScript(() => {
  const nativeFetch = window.fetch.bind(window);
  let adapter;
  window.fetch = async (input, init) => {
   const url = typeof input === 'string' ? input : input.url;
   if (!url.includes('/api/v1')) return nativeFetch(input, init);
   // Every API request is handled in this browser. No account/backend traffic.
   const path = url.split('/api/v1')[1];
   if (path === '/session/account') return new Response(JSON.stringify({ displayName: '测试昵称'.repeat(12), username: 'local_fixture_only' }), { headers: { 'content-type': 'application/json' } });
   if (path.includes('invitation')) return new Response(JSON.stringify(init?.method === 'POST' ? { invitationCode: 'LOCAL_TEST_ONLY_1', expiresAt: '2099-01-01T00:00:00Z' } : { items: [
    { id: 'fixture-pending', expiresAt: '2099-01-01T00:00:00Z', consumedAt: null, revokedAt: null },
    { id: 'fixture-expired', expiresAt: '2000-01-01T00:00:00Z', consumedAt: null, revokedAt: null },
    { id: 'fixture-consumed', expiresAt: '2099-01-01T00:00:00Z', consumedAt: '2000-01-01T00:00:00Z', revokedAt: null },
    { id: 'fixture-revoked', expiresAt: '2099-01-01T00:00:00Z', consumedAt: null, revokedAt: '2000-01-01T00:00:00Z' },
   ] }), { headers: { 'content-type': 'application/json' } });
   adapter ??= import('/src/data/index.ts').then(m => m.createDemoTransport({ persist: false, latencyMs: 0, latencyJitterMs: 0 }));
   const response = await (await adapter)(input, init);
   if (response.status === 204) return response;
   const body = await response.json();
   if (body?.user) body.user.demo = false;
   return new Response(JSON.stringify(body), { status: response.status, headers: { 'content-type': 'application/json' } });
  };
 });
 const page = await context.newPage();
 await page.goto('http://127.0.0.1:5192');
 await page.getByRole('link', { name: '注册新账号', exact: true }).waitFor();
 await page.screenshot({ path: `${dir}/login-${width}-${theme}.png`, fullPage: true });
 await page.getByRole('link', { name: '注册新账号', exact: true }).click();
 await page.screenshot({ path: `${dir}/registration-${width}-${theme}.png`, fullPage: true });
 await page.locator('.user-choice').first().click();
 await page.locator('.nav-item[href="/settings"]').first().evaluate(e => e.click());
 await page.getByLabel('昵称', { exact: true }).waitFor();
 await page.screenshot({ path: `${dir}/nickname-${width}-${theme}.png`, fullPage: true });
 await page.getByRole('button', { name: '修改密码', exact: true }).click();
 await page.getByLabel('新密码', { exact: true }).fill('LocalFixture123!');
 await page.getByLabel('确认新密码', { exact: true }).fill('Mismatch123!');
 await page.getByLabel('原密码', { exact: true }).fill('OldFixture123!');
 await page.getByRole('button', { name: '确认修改密码', exact: true }).click();
 await page.getByText('两次新密码不一致', { exact: true }).waitFor();
 await page.screenshot({ path: `${dir}/password-validation-${width}-${theme}.png`, fullPage: true });
 const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
 results.push({ width, theme, overflow });
 assert.equal(overflow, 0);
 if (width <= 700) await page.locator('.menu-btn').click();
 await page.locator('.who button.icon-btn').click();
 await page.locator('.user-choice').last().click();
 await page.locator('.nav-item[href="/admin"]').evaluate(e => e.click());
 await page.getByRole('heading', { name: '邀请注册', exact: true }).waitFor();
 await page.getByRole('button', { name: '创建邀请码', exact: true }).click();
 await page.getByText('LOCAL_TEST_ONLY_1', { exact: true }).waitFor();
 await page.screenshot({ path: `${dir}/admin-invitations-${width}-${theme}.png`, fullPage: true });
 await context.close();
}
await writeFile(`${dir}/results.json`, JSON.stringify(results, null, 2));
console.log(JSON.stringify(results));
await browser.close();
