// Guest access stays local to one tab and is cleared on logout or page leave.
import assert from 'node:assert/strict';
import { BASE_URL, chromiumExecutable, loadPlaywright } from './playwright-runtime.mjs';

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true });
const page = await browser.newPage();
const apiRequests = [];
page.on('request', (request) => {
  if (request.url().includes('/api/v1')) apiRequests.push(request.url());
});
const demoStudent = {
  id: '10000000-0000-4000-8000-000000000001',
  role: 'student',
  displayName: '演示学生（浏览器测试）',
  timezone: 'Asia/Shanghai',
  demo: true,
};
await page.route('**/api/v1/session', async (route) => {
  const method = route.request().method();
  if (method === 'DELETE') return route.fulfill({ status: 204 });
  const body = method === 'POST'
    ? {
        authenticated: true,
        user: demoStudent,
        capabilities: { push: false, offline: true, demoMode: true },
      }
    : {
        authenticated: false,
        demoUsers: [demoStudent, {
          id: '10000000-0000-4000-8000-000000000003',
          role: 'admin',
          displayName: '演示管理员（浏览器测试）',
        }],
        capabilities: { push: false, offline: true, demoMode: true },
      };
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
});

async function sessionState() {
  return page.evaluate(() => ({
    keys: Object.keys(sessionStorage),
    localKeys: Object.keys(localStorage),
    guestMode: sessionStorage.getItem('yso.workbench.guest.mode.v1'),
    guestUser: sessionStorage.getItem('yso.workbench.guest.user.v1'),
  }));
}

async function offlineStoreContainsGuest(userId) {
  return page.evaluate(async (guestId) => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('internship-workbench');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const storeNames = [...database.objectStoreNames];
    if (!storeNames.length) {
      database.close();
      return false;
    }
    const transaction = database.transaction(storeNames, 'readonly');
    const rows = await Promise.all(storeNames.map((name) => new Promise((resolve, reject) => {
      const request = transaction.objectStore(name).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    })));
    database.close();
    return JSON.stringify(rows).includes(guestId);
  }, userId);
}

try {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: '进入实习工作台' }).waitFor({ timeout: 20_000 });
  assert.equal(await page.getByRole('button', { name: /游客访问/ }).isVisible(), true);
  assert.equal(await page.getByRole('button', { name: /演示学生（浏览器测试）/ }).isVisible(), true);
  console.log('PASS 登录页默认显示，游客入口可选');

  await page.getByRole('button', { name: /游客访问/ }).click();
  await page.getByText(/早上好/).first().waitFor({ timeout: 20_000 });
  await page.getByText('游客体验 · 临时虚构数据').waitFor({ timeout: 10_000 });
  const entered = await sessionState();
  assert.equal(entered.guestMode, 'true');
  assert.match(entered.guestUser ?? '', /^ffffffff-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.ok(entered.keys.some((key) => key.startsWith('yso.workbench.guest.data.v1.')));
  assert.ok(!entered.localKeys.some((key) => key.startsWith('yso.workbench.guest.')));
  assert.equal(await offlineStoreContainsGuest(entered.guestUser), false, '游客身份不应写入离线缓存或同步队列');
  const apiRequestsAfterGuestLoad = apiRequests.length;
  await page.waitForTimeout(500);
  assert.equal(apiRequests.length, apiRequestsAfterGuestLoad, '游客数据请求不应发往后端');
  console.log('PASS 游客使用当前标签页独立数据，不请求后端');

  await page.getByRole('button', { name: '结束游客体验并清除数据' }).click();
  await page.getByRole('heading', { name: '进入实习工作台' }).waitFor({ timeout: 20_000 });
  const loggedOut = await sessionState();
  assert.equal(loggedOut.guestMode, null);
  assert.equal(loggedOut.guestUser, null);
  assert.ok(!loggedOut.keys.some((key) => key.startsWith('yso.workbench.guest.data.v1.')));
  console.log('PASS 退出后会话与游客数据已清除');

  await page.getByRole('button', { name: /游客访问/ }).click();
  await page.getByText(/早上好/).first().waitFor({ timeout: 20_000 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: '进入实习工作台' }).waitFor({ timeout: 20_000 });
  const afterLeave = await sessionState();
  assert.equal(afterLeave.guestMode, null);
  assert.equal(afterLeave.guestUser, null);
  assert.ok(!afterLeave.keys.some((key) => key.startsWith('yso.workbench.guest.data.v1.')));
  console.log('PASS 刷新离开页面后游客数据已清除并回到默认登录页');

  await page.getByRole('button', { name: /演示学生（浏览器测试）/ }).click();
  await page.getByText('演示站 · 虚构数据').waitFor({ timeout: 10_000 });
  await page.getByText('演示学生（浏览器测试）').waitFor({ timeout: 10_000 });
  console.log('PASS 原有演示身份登录入口仍可用');
} finally {
  await browser.close();
}
