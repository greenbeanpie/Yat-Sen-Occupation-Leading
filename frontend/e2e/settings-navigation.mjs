// Local-only synthetic accounts. No real credentials, API writes, or production data.
import assert from 'node:assert/strict';
import { BASE_URL, chromiumExecutable, loadPlaywright } from './playwright-runtime.mjs';
import { aiSettingsFixture } from './ai-settings-fixture.mjs';
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true });
try {
  for (const role of ['student', 'admin', 'super_admin']) {
    const page = await browser.newPage();
    const adminReads = [];
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/v1/**', async route => {
      const path = new URL(route.request().url()).pathname.replace('/api/v1', '');
      assert.equal(route.request().method(), 'GET', 'navigation must not mutate account data');
      if (path.startsWith('/admin/')) adminReads.push(path);
      let data = { items: [], changes: [], unreadCount: 0 };
      if (path === '/session') data = { authenticated: true, user: { id: `fixture-${role}`, role, displayName: 'Synthetic user', timezone: 'UTC', demo: false }, capabilities: { push: false, offline: true, demoMode: false } };
      if (path === '/session/account') data = { displayName: 'Synthetic user', username: 'fixture' };
      if (path === '/admin/settings') data = { registrationEnabled: true };
      if (path === '/admin/ai-settings') data = aiSettingsFixture();
      if (path === '/notifications/settings') data = { timezone: 'UTC', notifyTaskDue: true, notifyInterview: true };
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
    });
    await page.goto(`${BASE_URL}/settings/profile`);
    await page.getByRole('navigation', { name: '设置分类' }).waitFor();
    const tabs = page.getByRole('navigation', { name: '设置分类' });
    assert.equal(await tabs.getByRole('link', { name: '管理', exact: true }).count(), role === 'student' ? 0 : 1);
    assert.equal(await tabs.getByRole('link', { name: 'AI 配置', exact: true }).count(), role === 'super_admin' ? 1 : 0);
    const name = page.getByLabel('昵称', { exact: true });
    await name.fill('Unsaved fixture');
    page.once('dialog', dialog => dialog.dismiss());
    await tabs.getByRole('link', { name: '账户安全' }).click();
    assert.match(page.url(), /\/settings\/profile$/);
    assert.equal(await name.inputValue(), 'Unsaved fixture');
    page.once('dialog', dialog => dialog.accept());
    await tabs.getByRole('link', { name: '账户安全' }).click();
    await page.waitForURL('**/settings/security');
    await page.goBack();
    await page.waitForURL('**/settings/profile');
    await page.goForward();
    await page.waitForURL('**/settings/security');
    await tabs.getByRole('link', { name: '个人资料' }).click();
    await name.fill('Retained after Back');
    page.once('dialog', dialog => dialog.dismiss());
    await page.evaluate(() => history.back());
    await page.waitForTimeout(200);
    assert.match(page.url(), /\/settings\/profile$/);
    assert.equal(await name.inputValue(), 'Retained after Back');
    page.once('dialog', dialog => dialog.accept());
    await tabs.getByRole('link', { name: '外观与通知' }).click();
    await page.waitForURL('**/settings/notifications');
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.goto(`${BASE_URL}/settings/ai`);
    await page.waitForURL(role === 'super_admin' ? '**/settings/ai' : '**/settings/profile');
    if (role !== 'super_admin') assert(!adminReads.includes('/admin/ai-settings'));
    await page.goto(`${BASE_URL}/admin`);
    await page.waitForURL(role === 'student' ? '**/settings/profile' : '**/settings/management');
    if (role === 'student') assert.deepEqual(adminReads, []);
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`PASS ${role}: categories, direct URL access, legacy URL, dirty cancel, Back/Forward, mobile`);
  }
} finally { await browser.close(); }
