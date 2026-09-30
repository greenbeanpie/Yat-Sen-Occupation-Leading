import { mkdir, writeFile } from 'node:fs/promises';
import { loadPlaywright, chromiumExecutable } from './playwright-runtime.mjs';
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true });
const base = process.env.WORKBENCH_URL ?? 'http://127.0.0.1:5191';
const dir = new URL(`./.artifacts/audit-${process.env.AUDIT_STAGE ?? 'before'}/`, import.meta.url);
await mkdir(dir, { recursive: true });
const results = [];
for (const width of [1440, 390, 320]) for (const theme of ['light', 'dark']) {
 const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme });
 // Browser-only administrator fixture. Production/demo permission logic is unchanged.
 await context.addInitScript(() => {
  const json = Response.prototype.json;
  Response.prototype.json = async function () {
   const body = await json.call(this);
   if (body?.user?.role === 'admin') body.user.demo = false;
   return body;
  };
 });
 const page = await context.newPage();
 await page.goto(base);
 await page.locator('.user-choice').first().waitFor();
 await page.screenshot({ path: new URL(`login-${width}-${theme}.png`, dir).pathname.replace(/^\/([A-Z]:)/, '$1'), fullPage: true });
 await page.locator('.user-choice').first().click();
 await page.locator('.who').waitFor({ state: 'attached' });
 for (const route of ['/', '/profile', '/jobs', '/match', '/plan', '/applications', '/settings', '/admin']) {
  if (route === '/admin') {
   if (width <= 700) await page.locator('.menu-btn').click();
   await page.locator('.who button.icon-btn').click();
   await page.locator('.user-choice').last().click();
   await page.locator('.who').waitFor({ state: 'attached' });
  }
  await page.goto(base + route);
  await page.locator('h1').waitFor();
  await page.waitForTimeout(650);
  const name = route.slice(1) || 'dashboard';
  const findings = await page.evaluate(() => ({
   overflow: document.documentElement.scrollWidth - innerWidth,
   wide: [...document.querySelectorAll('.content *')].filter(e => { const r = e.getBoundingClientRect(); return r.width && r.right > innerWidth + 1; }).slice(0, 8).map(e => `${e.tagName}.${e.className}`),
   buttons: [...document.querySelectorAll('.content button')].map(e => ({ text: e.textContent, disabled: e.disabled })),
   tiny: [...document.querySelectorAll('.content p,.content label,.content small')].filter(e => parseFloat(getComputedStyle(e).fontSize) < 10).length,
  }));
  await page.screenshot({ path: new URL(`${name}-${width}-${theme}.png`, dir).pathname.replace(/^\/([A-Z]:)/, '$1'), fullPage: true });
  results.push({ route, width, theme, ...findings });
 }
 await context.close();
}
await writeFile(new URL('results.json', dir), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results.map(r => ({ route: r.route, width: r.width, theme: r.theme, overflow: r.overflow, wide: r.wide })), null, 2));
if (results.some(r => r.overflow > 1)) process.exitCode = 1;
await browser.close();
