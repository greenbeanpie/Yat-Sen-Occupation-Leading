// Browser regression against local UI, with explicitly mocked API responses.
// Real transaction/authentication behavior is covered by backend workerd tests.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { BASE_URL, chromiumExecutable, loadPlaywright } from './playwright-runtime.mjs';
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true });
let server;
if (process.argv.includes('--serve')) {
  const { createServer } = await import('vite');
  server = await createServer({ server: { host: '127.0.0.1', port: 5189, strictPort: true } });
  await server.listen();
}
const page = await browser.newPage();
const submissions = [];
await page.route('**/api/v1/**', route => {
  const request = route.request(), path = new URL(request.url()).pathname;
  if (path.endsWith('/session/register')) {
    submissions.push(request.postDataJSON());
    return route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: { code: 'invalid_request', message: '无法注册', details: [{ field: 'invitationCode', issue: '邀请码无效、已使用或已过期' }] } }) });
  }
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ authenticated: false, demoUsers: [], capabilities: { push: false, offline: true, demoMode: true } }) });
});
try {
  await page.goto(server ? 'http://127.0.0.1:5189' : BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.getByRole('link', { name: '注册新账号' }).click();
  await page.getByLabel('用户名', { exact: true }).fill('Browser_User');
  const password = crypto.randomUUID();
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByLabel('确认密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '注册并进入' }).click();
  assert.equal(submissions.length, 0, 'missing invitation must block browser submission');
  // A fixture-shaped code only, never a live invitation.
  await page.getByLabel('一次性邀请码').fill('AbCdEfGh1234_-XY');
  await page.getByRole('button', { name: '注册并进入' }).click();
  await page.getByText(/邀请码: 邀请码无效/).waitFor();
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].email, undefined, 'blank email stays optional');
  assert.equal(submissions[0].invitationCode.length, 16);
  assert.equal(await page.getByLabel('用户名', { exact: true }).inputValue(), 'Browser_User');
  await page.getByLabel('邮箱（选填，未验证）').fill('test@example.invalid');
  await page.getByRole('button', { name: '注册并进入' }).click();
  await page.waitForFunction(() => document.querySelector('button.btn.primary')?.textContent === '注册并进入');
  assert.equal(submissions[1].email, 'test@example.invalid');
  assert.ok(await page.getByText(/不能用于找回密码/).isVisible());
  const stored = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  assert.ok(!stored.includes(password));
  assert.ok(!stored.includes('AbCdEfGh1234_-XY'));
  await mkdir(new URL('./.artifacts/', import.meta.url), { recursive: true });
  // Clear sensitive fixture fields before capturing screenshots.
  await page.getByLabel('密码', { exact: true }).fill('');
  await page.locator('input[autocomplete="new-password"]').nth(1).fill('');
  await page.getByLabel('一次性邀请码').fill('');
  await page.screenshot({ path: new URL('./.artifacts/invitation-register.png', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'), fullPage: true });
  console.log('PASS invitation form: required 16-char code, optional email, error feedback, recovery notice, no plaintext web storage');
} finally { await browser.close(); await server?.close(); }
