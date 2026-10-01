import { aiSettingsFixture } from './ai-settings-fixture.mjs';
// Three-role UI verification using an isolated, mocked HTTP API.
// Run against a frontend dev/preview server with WORKBENCH_URL and CHROMIUM_PATH as needed.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { BASE_URL, chromiumExecutable, loadPlaywright } from './playwright-runtime.mjs';

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true });
const errors = [];
const userFixture = (role, id = 'actor') => ({ id, username: id, displayName: id === 'actor' ? '当前管理账户' : '测试用户', role, disabled: false, timezone: 'Asia/Shanghai', demo: false });

async function scenario(role, demo = false) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  page.on('pageerror', error => errors.push(error.message));
  let actor = { ...userFixture(role), demo };
  const users = [actor, userFixture('student', 'general'), userFixture('admin', 'administrator')];
  let registrationEnabled = true;
  let rejectRoleChange = false;
  const mutations = [];
  await page.route('**/api/v1/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace('/api/v1', '');
    const method = request.method();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (method !== 'GET') mutations.push({ path, method, body: request.postDataJSON() });
    if (path === '/session') return json({ authenticated: true, user: actor, capabilities: { push: false, offline: true, demoMode: demo } });
    if (path === '/admin/ai-settings') return json(aiSettingsFixture());
    if (path === '/admin/users' && method === 'GET') return json({ items: users });
    if (path === '/admin/settings') {
      if (method === 'PUT') registrationEnabled = request.postDataJSON().registrationEnabled;
      return json({ registrationEnabled });
    }
    if (path.startsWith('/admin/users/') && method !== 'GET') {
      const target = users.find(user => user.id === path.split('/')[3]);
      if (path.endsWith('/role') && rejectRoleChange) return json({ error: { code: 'last_super_admin', message: '至少保留一名启用的超级管理员。' } }, 409);
      Object.assign(target, request.postDataJSON());
      if (target.id === actor.id) actor = { ...target };
      return route.fulfill({ status: 204 });
    }
    if (path === '/profile') return json({ targetRoles: [] });
    if (path === '/applications/stats') return json({ efficiency: null });
    return json({ items: [], changes: [], results: [], unreadCount: 0, nextCursor: null });
  });
  await page.goto(`${BASE_URL}/admin`, { waitUntil: 'networkidle' });
  return { page, mutations, rejectRoleChange: value => { rejectRoleChange = value; }, getRegistration: () => registrationEnabled };
}

try {
  for (const [role, demo] of [['student', false], ['admin', true], ['super_admin', true]]) {
    const { page } = await scenario(role, demo);
    await page.waitForURL(`${BASE_URL}/`);
    assert.equal(await page.getByRole('link', { name: '管理中心', exact: true }).count(), 0);
    assert.equal(await page.getByRole('heading', { name: '用户管理', exact: true }).count(), 0);
    await page.close();
  }
  console.log('PASS 一般用户与演示身份均无法进入账户管理');

  const admin = await scenario('admin');
  await admin.page.getByRole('heading', { name: '用户管理', exact: true }).waitFor();
  assert.equal(await admin.page.getByRole('heading', { name: '系统设置', exact: true }).count(), 0);
  assert.equal(await admin.page.getByRole('button', { name: '调整角色', exact: true }).count(), 0);
  assert.equal(await admin.page.locator('.admin-user-row').count(), 1);
  const row = admin.page.locator('.admin-user-row');
  await row.getByRole('button', { name: '编辑昵称', exact: true }).click();
  const nameDialog = admin.page.getByRole('dialog', { name: '编辑用户昵称' });
  await nameDialog.getByRole('textbox', { name: '昵称', exact: true }).fill('一般用户新昵称');
  await nameDialog.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(admin.mutations.length, 0);
  await row.getByRole('button', { name: '编辑昵称', exact: true }).click();
  await nameDialog.getByRole('textbox', { name: '昵称', exact: true }).fill('一般用户新昵称');
  await nameDialog.getByRole('button', { name: '保存修改', exact: true }).click();
  await row.getByText('一般用户新昵称', { exact: true }).waitFor();
  assert.deepEqual(admin.mutations[0], { path: '/admin/users/general', method: 'PATCH', body: { displayName: '一般用户新昵称' } });
  await row.getByRole('button', { name: '停用账户', exact: true }).click();
  await admin.page.keyboard.press('Escape');
  assert.equal(await admin.page.getByRole('dialog').count(), 0);
  assert.equal(admin.mutations.length, 1);
  await row.getByRole('button', { name: '停用账户', exact: true }).click();
  await admin.page.getByRole('button', { name: '确认停用', exact: true }).evaluate(button => { button.click(); button.click(); });
  await row.getByText('已停用', { exact: true }).waitFor();
  assert.equal(admin.mutations.length, 2, '重复点击不得重复提交');
  console.log('PASS 管理员只管理一般用户；昵称、停用、取消和重复提交检查通过');
  await admin.page.close();

  const superAdmin = await scenario('super_admin');
  const { page } = superAdmin;
  await page.getByRole('heading', { name: '系统设置', exact: true }).waitFor();
  assert.equal(await page.locator('.admin-user-row').count(), 3);
  const currentRow = page.locator('.admin-user-row').filter({ hasText: '当前管理账户' });
  assert.equal(await currentRow.getByRole('button', { name: '停用账户', exact: true }).count(), 0);
  await page.getByRole('checkbox', { name: '允许受邀注册新账户' }).uncheck();
  await page.getByRole('button', { name: '保存注册设置', exact: true }).click();
  await page.getByText('当前状态：新账户注册已暂停', { exact: true }).waitFor();
  assert.equal(superAdmin.getRegistration(), false);
  await page.getByRole('checkbox', { name: '允许受邀注册新账户' }).check();
  await page.getByRole('button', { name: '保存注册设置', exact: true }).click();
  await page.getByText('当前状态：受邀注册已开放', { exact: true }).waitFor();
  assert.equal(superAdmin.getRegistration(), true);

  superAdmin.rejectRoleChange(true);
  await currentRow.getByRole('button', { name: '调整角色', exact: true }).click();
  await page.getByRole('combobox', { name: '新角色' }).selectOption('admin');
  await page.getByRole('dialog').getByRole('button', { name: '保存修改', exact: true }).click();
  await page.getByRole('dialog').getByText('至少保留一名启用的超级管理员。', { exact: true }).waitFor();
  assert.equal(await page.getByRole('dialog', { name: '记录版本已变化' }).count(), 0);
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
  console.log('PASS 超级管理员系统设置可保存；最后一名超级管理员错误就地显示');

  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, '移动端不应横向溢出');
  await mkdir(new URL('./.artifacts/', import.meta.url), { recursive: true });
  await page.screenshot({ path: new URL('./.artifacts/roles-mobile.png', import.meta.url).pathname, fullPage: true });
  await page.setViewportSize({ width: 1280, height: 1000 });
  superAdmin.rejectRoleChange(false);
  await currentRow.getByRole('button', { name: '调整角色', exact: true }).click();
  await page.getByRole('combobox', { name: '新角色' }).selectOption('admin');
  await page.getByRole('dialog').getByRole('button', { name: '保存修改', exact: true }).click();
  await page.getByText('管理员身份', { exact: true }).waitFor();
  assert.equal(await page.getByRole('heading', { name: '系统设置', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '调整角色', exact: true }).count(), 0);
  assert.equal(await page.locator('.admin-user-row').count(), 1);
  assert.equal(await page.evaluate(() => JSON.stringify(localStorage).includes('api:/admin/users') || JSON.stringify(localStorage).includes('api:/admin/settings')), false);
  console.log('PASS 自身角色降低后立即更新身份和管理权限；移动端布局无溢出');
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
