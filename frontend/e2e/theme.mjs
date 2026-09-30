import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromiumExecutable, loadPlaywright } from './playwright-runtime.mjs';

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true });
const base = process.env.WORKBENCH_URL ?? 'http://127.0.0.1:5174';
const artifacts = fileURLToPath(new URL('./.artifacts/theme/', import.meta.url));
await mkdir(artifacts, { recursive: true });
const results = [];
async function theme(page, expected) {
  await page.waitForFunction(value => document.documentElement.dataset.theme === value, expected);
}
async function screenshot(page, name) {
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${artifacts}${name}.png`, fullPage: true });
}
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  const select = page.getByRole('combobox', { name: '外观主题' });
  await select.waitFor();
  await theme(page, 'light');
  await screenshot(page, 'login-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await theme(page, 'dark');
  await screenshot(page, 'login-dark');
  await select.selectOption('light');
  await theme(page, 'light');
  await page.reload();
  await theme(page, 'light');
  assert.equal(await select.inputValue(), 'light');
  const second = await context.newPage();
  await second.goto(base);
  await second.getByRole('combobox', { name: '外观主题' }).waitFor();
  await select.selectOption('dark');
  await theme(second, 'dark');
  await select.selectOption('system');
  await theme(page, 'dark');
  await theme(second, 'light');
  await page.emulateMedia({ colorScheme: 'light' });
  await theme(page, 'light');
  await select.focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  assert.equal(await select.evaluate(node => node === document.activeElement), true);
  results.push('PASS system changes, explicit override, reload, cross-tab, return to system, keyboard');

  // Enter only local fictitious demo data; never submit credentials or invitations.
  await page.getByRole('button', { name: /演示学生/ }).first().click();
  await page.locator('.app-shell').waitFor();
  for (const mode of ['light', 'dark']) {
    await select.selectOption(mode);
    const contrast = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      const luminance = name => {
        const hex = style.getPropertyValue(name).trim().slice(1);
        const rgb = hex.length === 3 ? hex.split('').map(x => x + x).join('') : hex;
        const [r, g, b] = [0, 2, 4].map(i => {
          const c = parseInt(rgb.slice(i, i + 2), 16) / 255;
          return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4;
        });
        return .2126 * r + .7152 * g + .0722 * b;
      };
      return [['--ink', '--surface'], ['--muted', '--surface-alt'], ['--link', '--surface'],
        ['--success', '--success-soft'], ['--warning', '--warning-soft'], ['--danger', '--danger-soft'],
        ['--on-brand', '--blue']].map(([fg, bg]) => {
          const a = luminance(fg), b = luminance(bg);
          return { fg, bg, ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) };
        });
    });
    for (const pair of contrast) assert.ok(pair.ratio >= 4.5, `${mode} ${JSON.stringify(pair)}`);
    for (const route of ['/', '/profile', '/jobs', '/match', '/plan', '/applications', '/settings', '/admin']) {
      await page.goto(`${base}${route}`);
      await page.locator('h1').first().waitFor();
      await theme(page, mode);
      await screenshot(page, `${route === '/' ? 'dashboard' : route.slice(1)}-${mode}`);
    }
  }
  results.push('PASS semantic text/status/button palette WCAG AA contrast >= 4.5:1');
  await page.goto(`${base}/jobs`);
  await page.getByRole('button', { name: /添加私人 JD/ }).click();
  await page.locator('.modal').waitFor();
  await screenshot(page, 'modal-dark');
  await page.locator('.modal').getByRole('button', { name: /关闭/ }).click();
  await select.selectOption('light');
  await page.getByRole('button', { name: /添加私人 JD/ }).click();
  await screenshot(page, 'modal-light');
  results.push('PASS desktop business pages and modal in both themes');
  await page.goto(`${base}/match`);
  const jobs = page.getByLabel('选择岗位');
  await jobs.locator('option').nth(1).waitFor({ state: 'attached' });
  await jobs.selectOption(await jobs.locator('option').nth(1).getAttribute('value'));
  await page.getByRole('button', { name: '开始分析' }).click();
  await page.locator('.match-result').waitFor({ timeout: 30000 });
  for (const mode of ['light', 'dark']) {
    await select.selectOption(mode);
    await screenshot(page, `match-chart-states-${mode}`);
  }
  results.push('PASS local demo matching score charts and condition states both themes');

  const mobile = await context.newPage();
  await mobile.setViewportSize({ width: 390, height: 844 });
  for (const mode of ['light', 'dark']) {
    await mobile.goto(base);
    await mobile.getByRole('combobox', { name: '外观主题' }).selectOption(mode);
    for (const route of ['/', '/profile', '/jobs', '/match', '/plan', '/applications', '/settings']) {
      await mobile.goto(`${base}${route}`);
      await mobile.locator('h1').first().waitFor();
      assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, route);
      await screenshot(mobile, `mobile-${route === '/' ? 'dashboard' : route.slice(1)}-${mode}`);
    }
  }
  results.push('PASS mobile 390x844 business pages without horizontal overflow');
  await mobile.setViewportSize({ width: 320, height: 740 });
  await mobile.goto(base);
  await mobile.locator('.app-shell').waitFor();
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await screenshot(mobile, 'mobile-320-dark');

  const firstFrame = await browser.newPage({ colorScheme: 'light' });
  await firstFrame.addInitScript(() => localStorage.setItem('yso-theme', 'dark'));
  await firstFrame.route(/\/src\/main\.tsx/, route => route.abort());
  await firstFrame.goto(base);
  await theme(firstFrame, 'dark');
  assert.equal(await firstFrame.locator('#root').innerHTML(), '');
  results.push('PASS persisted dark theme applied before React loads');

  // Ordinary login/registration layout, with a read-only local session response.
  const login = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await login.route('**/api/v1/session', route => route.fulfill({ json: { user: null, demoUsers: [] } }));
  await login.goto(process.env.THEME_LOGIN_URL ?? 'http://127.0.0.1:5175');
  await login.getByRole('link', { name: '注册新账号' }).waitFor();
  for (const mode of ['light', 'dark']) {
    await login.getByRole('combobox', { name: '外观主题' }).selectOption(mode);
    await screenshot(login, `credential-login-${mode}`);
    await login.getByRole('link', { name: '注册新账号' }).click();
    await login.getByText('一次性邀请码', { exact: true }).waitFor();
    await screenshot(login, `invitation-register-${mode}`);
    assert.equal(await login.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await login.getByRole('link', { name: '去登录' }).click();
  }
  results.push('PASS mobile login and invitation registration both themes (no submission)');

  const blocked = await browser.newContext({ colorScheme: 'dark' });
  await blocked.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('blocked', 'SecurityError'); } });
  });
  const unavailable = await blocked.newPage();
  await unavailable.goto(base);
  await unavailable.getByRole('combobox', { name: '外观主题' }).waitFor();
  await theme(unavailable, 'dark');
  await unavailable.getByRole('combobox', { name: '外观主题' }).selectOption('light');
  await theme(unavailable, 'light');
  await unavailable.getByRole('combobox', { name: '外观主题' }).selectOption('system');
  await unavailable.emulateMedia({ colorScheme: 'light' });
  await theme(unavailable, 'light');
  results.push('PASS blocked storage still supports manual and system themes');
  assert.deepEqual(errors, []);
} finally {
  await writeFile(`${artifacts}results.txt`, results.join('\n'));
  console.log(results.join('\n'));
  await browser.close();
}
