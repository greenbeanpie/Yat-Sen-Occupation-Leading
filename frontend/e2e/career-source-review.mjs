// Cloud-local browser regression with fixture HTTP API only. No school or model calls.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromiumExecutable, loadPlaywright } from './playwright-runtime.mjs';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const types = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  const file = path.resolve(dist, `.${pathname}`);
  try {
    if (!file.startsWith(dist)) throw new Error('invalid path');
    const body = await readFile(file);
    response.setHeader('Content-Type', types[path.extname(file)] ?? 'application/octet-stream'); response.end(body);
  } catch {
    response.setHeader('Content-Type', 'text/html'); response.end(await readFile(path.join(dist, 'index.html')));
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true });
const errors = [];
const now = new Date().toISOString(), expiresAt = new Date(Date.now() + 900000).toISOString(), hash = 'a'.repeat(64);
const item = { id: '997448', title: '浏览器 fixture：公开招聘公告', url: 'https://career.sysu.edu.cn/campus/view/id/997448', publishedAt: '2026-09-30 21:45:47', pinned: false };
const listing = { schemaVersion: 1, items: [item], retrievedAt: now, expiresAt };
const source = { text: '公开公告正文\n工程师\n本科', versionHash: hash, metadata: { url: item.url, numericId: item.id, retrievedAt: now,
  originalDate: '2026-09-30 21:45', sourceExpiry: '过期时间：2026-11-30', captureMethod: 'static-html-text', partial: true } };
const preview = { schemaVersion: 1, source, title: item.title, employer: null, warnings: ['Fixture：图片未读取'], expiresAt };
const fact = { value: '工程师', evidence: { start: 7, end: 10, quote: '工程师' } };
const draft = { status: 'needs-human-review', provider: 'fixture-only', source, warnings: ['Fixture：需要逐条审核'], candidate: {
  schemaVersion: 1, title: fact, employer: null, applicationDeadline: null, sharedRequirements: [], positions: [], ambiguities: ['Fixture：工作地点未知'] } };
const artifacts = fileURLToPath(new URL('./.artifacts/career-review/', import.meta.url));
await mkdir(artifacts, { recursive: true });
try {
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    const mutations = []; let cache = null, rejectExtract = true;
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() !== 'error') return;
      const expectedFixtureFailure = message.location().url.includes('/admin/career-source/extract')
        && /Failed to load resource.*502/.test(message.text());
      if (!expectedFixtureFailure) errors.push(message.text());
    });
    await page.route('**/api/v1/**', route => {
      const request = route.request(), pathname = new URL(request.url()).pathname.replace('/api/v1', ''), method = request.method();
      const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      if (method !== 'GET') mutations.push({ pathname, body: request.postDataJSON() });
      if (pathname === '/session') return json({ authenticated: true, user: { id: 'fixture-admin', role: 'admin', displayName: 'Fixture管理账户', timezone: 'Asia/Shanghai', demo: false }, capabilities: { push: false, offline: true, demoMode: false } });
      if (pathname === '/admin/career-source') return json({ schemaVersion: 1, sourceId: 'sysu-campus', cachedList: cache, extractionAvailable: true, extractionUnavailableReason: null, cacheTtlSeconds: 900, publicationSupported: false });
      if (pathname === '/admin/career-source/refresh') { cache = listing; return json(listing); }
      if (pathname === '/admin/career-source/preview') return json(preview);
      if (pathname === '/admin/career-source/extract') {
        if (rejectExtract) return json({ error: { code: 'career_extraction_failed', message: 'Fixture：模型请求或证据校验失败，未产生可用候选' } }, 502);
        return new Promise(resolve => setTimeout(() => resolve(json(draft)), 100));
      }
      if (pathname === '/profile') return json({ targetRoles: [] });
      if (pathname === '/applications/stats') return json({ efficiency: null });
      return json({ items: [], unreadCount: 0, changes: [], results: [], nextCursor: null });
    });
    await page.goto(`${base}/admin/jobs`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: '中大就业网公告', exact: true }).waitFor(); assert.equal(mutations.length, 0);
    await page.getByRole('button', { name: '获取首页公告', exact: true }).click();
    await page.getByRole('button', { name: '预览来源', exact: true }).click();
    await page.getByText('图片、二维码或嵌入内容未读取', { exact: false }).waitFor();
    await page.getByRole('button', { name: '提取待审核候选', exact: true }).click();
    await page.getByText('Fixture：模型请求或证据校验失败，未产生可用候选', { exact: true }).waitFor();
    assert.equal(await page.getByRole('heading', { name: '待人工审核候选', exact: true }).count(), 0);
    rejectExtract = false;
    await page.getByRole('button', { name: '提取待审核候选', exact: true }).evaluate(button => { button.click(); button.click(); });
    await page.getByRole('heading', { name: '待人工审核候选', exact: true }).waitFor();
    assert.deepEqual(mutations.map(mutation => mutation.pathname), ['/admin/career-source/refresh', '/admin/career-source/preview', '/admin/career-source/extract', '/admin/career-source/extract']);
    assert.deepEqual(mutations[3].body, { id: item.id, sourceVersionHash: hash });
    await page.locator('.career-candidate-review summary').first().click();
    await page.locator('.career-source-snapshot').scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no horizontal overflow');
    await page.screenshot({ path: path.join(artifacts, `${width}.png`), fullPage: true });
    await page.close(); console.log(`PASS fixture browser ${width}px: explicit source/preview, visible failure, one rapid-click request, evidence review and no overflow`);
  }
  assert.deepEqual(errors, []); console.log('PASS no browser console errors; no real school/model/private-profile requests');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
