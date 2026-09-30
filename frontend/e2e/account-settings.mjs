// Browser UI regression with synthetic local fixtures; never contacts production.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { BASE_URL, chromiumExecutable, loadPlaywright } from './playwright-runtime.mjs';
assert.ok(['localhost', '127.0.0.1'].includes(new URL(BASE_URL).hostname), 'Local fixture test only');
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true });
try {
  const page = await browser.newPage();
  let authenticated = true;
  let expired = false;
  let passwordRequests = 0;
  let nicknameRequests = 0;
  let demo = false;
  const user = { id: '20000000-0000-4000-8000-000000000001', role: 'student', displayName: '历史昵称', timezone: 'Asia/Shanghai', demo: false };
  const original = 'Fixture-Old-Password-123!';
  const next = 'Fixture-New-Password-456!';
  await page.route('**/api/v1/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api/v1', '');
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/session') return json({ authenticated, user: authenticated ? { ...user, demo } : null, capabilities: { push: false, offline: true, demoMode: false } });
    if (path === '/session/account') {
      if (request.method() === 'GET') return json({ displayName: user.displayName, username: 'fixture_user' });
      nicknameRequests++;
      user.displayName = request.postDataJSON().displayName.trim();
      return route.fulfill({ status: 204 });
    }
    if (path === '/session/password') {
      passwordRequests++;
      await new Promise(resolve => setTimeout(resolve, 120));
      if (expired) return json({ error: { message: '会话已失效' } }, 401);
      if (request.postDataJSON().currentPassword !== original) return json({ error: { message: '原密码不正确' } }, 422);
      authenticated = false;
      return route.fulfill({ status: 204 });
    }
    if (path === '/notifications/settings') return json({ timezone: 'Asia/Shanghai', notifyTaskDue: true, notifyInterview: true, updatedAt: new Date().toISOString() });
    if (path === '/sync') return json({ results: [] });
    return json({ items: [], changes: [], unreadCount: 0, lastSync: new Date().toISOString() });
  });
  await page.goto(`${BASE_URL}/settings`);
  await page.getByLabel('昵称', { exact: true }).fill('取消的昵称');
  await page.getByRole('button', { name: '取消昵称修改', exact: true }).click();
  assert.equal(await page.getByLabel('昵称', { exact: true }).inputValue(), '历史昵称');
  assert.equal(nicknameRequests, 0);
  await page.getByLabel('昵称', { exact: true }).fill('新昵称');
  await page.getByRole('button', { name: '保存昵称', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '昵称已保存' }).waitFor();
  assert.equal(user.displayName, '新昵称');
  await page.getByRole('button', { name: '修改密码', exact: true }).click();
  await page.getByLabel('原密码', { exact: true }).fill(original);
  await page.getByRole('button', { name: '取消修改密码', exact: true }).click();
  assert.equal(passwordRequests, 0);
  await page.getByRole('button', { name: '修改密码', exact: true }).click();
  assert.equal(await page.getByLabel('原密码', { exact: true }).inputValue(), '');
  async function fillPassword(old) {
    await page.getByLabel('原密码', { exact: true }).fill(old);
    await page.getByLabel('新密码', { exact: true }).fill(next);
    await page.getByLabel('确认新密码', { exact: true }).fill(next);
  }
  await fillPassword('Fixture-Wrong-Password-123!');
  mkdirSync('e2e/.artifacts', { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.locator('.theme-select select').selectOption(theme);
    await page.screenshot({ path: `e2e/.artifacts/account-${theme}.png`, fullPage: true });
  }
  await page.getByRole('button', { name: '确认修改密码', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '原密码不正确' }).waitFor();
  assert.equal(await page.getByLabel('原密码', { exact: true }).inputValue(), '');
  await fillPassword(original);
  const before = passwordRequests;
  await page.getByRole('button', { name: '确认修改密码', exact: true }).evaluate(button => {
    button.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    button.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await page.getByText('密码已修改，所有设备均已退出，请使用新密码重新登录。', { exact: true }).waitFor();
  assert.equal(passwordRequests, before + 1);
  authenticated = true; expired = true;
  await page.reload();
  await page.getByRole('button', { name: '修改密码', exact: true }).click();
  await fillPassword(original);
  await page.getByRole('button', { name: '确认修改密码', exact: true }).click();
  await page.getByText('会话已失效，请重新登录。', { exact: true }).waitFor();
  demo = true;
  await page.reload();
  await page.getByText('演示与游客身份不能修改账户信息或密码。请登录个人账户使用此功能。', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '修改密码', exact: true }).count(), 0);
  mkdirSync('e2e/.artifacts', { recursive: true });
  await page.screenshot({ path: 'e2e/.artifacts/account-demo.png', fullPage: true });
  console.log('Account browser flow passed: nickname save/cancel, password cancel/wrong original/duplicate submit, logout, expired session, demo guard.');
} finally { await browser.close(); }
