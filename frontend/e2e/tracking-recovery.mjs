// Real React UI against an in-memory HTTP fixture; never contacts the backend.
// Run: CHROMIUM_PATH=/path/to/chromium node e2e/tracking-recovery.mjs
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromiumExecutable, loadPlaywright } from './playwright-runtime.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const userId = '10000000-0000-4000-8000-000000000001';
const applicationId = '20000000-0000-4000-8000-000000000001';
const now = new Date().toISOString();
const base = { version: 1, deleted: false, createdAt: now, updatedAt: now, userId };
const original = {
  ...base, id: applicationId, jobId: null, jobTitle: '历史保留测试岗位',
  company: 'Fixture Company', status: 'interviewing', notes: '归档后仍保留的原始备注',
};
const applications = [structuredClone(original)];
const events = [{
  ...base, id: '30000000-0000-4000-8000-000000000001', applicationId,
  type: 'feedback', note: '保留的投递反馈', occurredAt: now,
}];
const interviews = [{
  ...base, id: '40000000-0000-4000-8000-000000000001', applicationId,
  stage: '复试历史', scheduledAt: now, locationOrLink: '历史面试地点',
  result: 'passed', feedback: '面试反馈保留',
}];
const timeEntries = [{
  ...base, id: '50000000-0000-4000-8000-000000000001', applicationId,
  minutes: 120, spentOn: now.slice(0, 10), note: '关联工时保留',
}];
const jobs = ['列表详情并发岗位', '失败重试岗位'].map((title, index) => ({
  ...base, id: `60000000-0000-4000-8000-00000000000${index + 1}`,
  scope: 'public', status: 'published', title, company: 'Fixture Jobs',
  location: 'Remote', deadlineDate: null, sourceUrl: null,
  jdText: 'Browser regression fixture', jobVersion: 1, requirements: [],
}));
const creates = [];
const archives = [];
const restores = [];
const unexpected = [];
const pageErrors = [];
let createGate;
let failCreate = false;
let failArchive = false;
let failRestore = false;
let server;
let browser;
let page;

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function json(route, data, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
}

function fail(route, message) {
  return json(route, { error: { code: 'temporary_failure', message } }, 500);
}

async function apiFixture(route) {
  const request = route.request();
  const url = new URL(request.url());
  const path = url.pathname.replace('/api/v1', '');
  const method = request.method();
  if (method === 'GET' && path === '/session') return json(route, {
    authenticated: true,
    user: { id: userId, role: 'student', displayName: 'UI regression fixture', timezone: 'UTC', demo: true },
    capabilities: { push: false, offline: true, demoMode: true },
  });
  if (method === 'GET' && path === '/sync/changes') return json(route, { changes: [], cursor: 0, hasMore: false });
  if (method === 'GET' && path === '/applications') {
    const archived = url.searchParams.get('archived') === 'true';
    return json(route, { items: applications.filter((item) => item.deleted === archived) });
  }
  if (method === 'GET' && path === '/applications/stats') {
    const active = !applications.find((item) => item.id === applicationId).deleted;
    return json(route, {
      from: url.searchParams.get('from'), to: url.searchParams.get('to'),
      interviewedCount: active ? 1 : 0, totalHours: active ? 2 : 0,
      efficiency: active ? 5 : null,
    });
  }
  if (method === 'GET' && path === '/time-entries') return json(route, { items: timeEntries });
  if (method === 'GET' && path === `/applications/${applicationId}/events`) return json(route, { items: events });
  if (method === 'GET' && path === `/applications/${applicationId}/interviews`) return json(route, { items: interviews });
  if (method === 'GET' && path === '/jobs') return json(route, { items: url.searchParams.get('scope') === 'mine' ? [] : jobs });
  if (method === 'GET' && jobs.some((job) => path === `/jobs/${job.id}`)) return json(route, jobs.find((job) => path === `/jobs/${job.id}`));
  if (method === 'POST' && path === '/applications') {
    const draft = request.postDataJSON();
    creates.push(draft);
    if (createGate) await createGate.promise;
    if (failCreate) return fail(route, '创建暂时失败，请重试');
    // Deliberately do not deduplicate fixture creates: duplicate UI requests fail assertions.
    const item = { ...base, ...draft, id: draft.creationId, version: 1 };
    applications.push(item);
    return json(route, item, 201);
  }
  if (method === 'DELETE' && path === `/applications/${applicationId}`) {
    archives.push(path);
    if (failArchive) return fail(route, '归档暂时失败，请重试');
    const item = applications.find((candidate) => candidate.id === applicationId);
    item.deleted = true;
    item.version += 1;
    return route.fulfill({ status: 204 });
  }
  if (method === 'POST' && path === `/applications/${applicationId}/restore`) {
    const body = request.postDataJSON();
    restores.push(body);
    if (failRestore) return fail(route, '恢复暂时失败，请重试');
    const item = applications.find((candidate) => candidate.id === applicationId);
    assert.equal(body.baseVersion, item.version, 'restore must send the archived version');
    item.deleted = false;
    item.version += 1;
    return json(route, item);
  }
  unexpected.push(`${method} ${url.pathname}${url.search}`);
  return fail(route, 'Unexpected fixture request');
}

async function settle() {
  await page.waitForLoadState('networkidle');
  await page.locator('.busy-line').waitFor({ state: 'hidden' });
}

async function counts(active, archived) {
  await page.getByRole('button', { name: `未归档（${active}）`, exact: true }).waitFor();
  await page.getByRole('button', { name: `已归档（${archived}）`, exact: true }).waitFor();
  assert.equal(await page.locator('.stat-card').filter({ hasText: '未归档的投递记录' }).locator('strong').textContent(), String(active));
}

async function stats(interviewed, hours, efficiency) {
  await settle();
  for (const [label, value] of [
    ['获得面试的投递', interviewed], ['实际投入', hours], ['每 10 小时面试数', efficiency],
  ]) assert.equal(await page.locator('.stat-card').filter({ hasText: label }).locator('strong').textContent(), value);
}

async function submitTwice(form) {
  await form.evaluate((element) => {
    element.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

try {
  server = await createServer({
    root, mode: 'development',
    define: { 'import.meta.env.VITE_DATA_SOURCE': JSON.stringify('http'), 'import.meta.env.VITE_API_BASE': JSON.stringify('/api/v1') },
    server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
  });
  await server.listen();
  const address = server.httpServer.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const { chromium } = await loadPlaywright();
  browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  page.setDefaultTimeout(10_000);
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.route('**/api/v1/**', apiFixture);
  await page.goto(`${baseUrl}/applications`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: '记录每次行动与反馈' }).waitFor();
  await counts(1, 0);
  await stats('1', '2.0 小时', '5.0');

  const newForm = page.locator('form').filter({ has: page.getByRole('button', { name: '创建记录', exact: true }) });
  await newForm.getByLabel('岗位名称').fill('同轮双提交岗位');
  await newForm.getByLabel('公司名称').fill('Manual Company');
  await newForm.getByLabel('备注', { exact: true }).fill('第一次尝试的备注');
  createGate = deferred();
  const createdRequest = page.waitForRequest((request) => request.method() === 'POST' && request.url().endsWith('/applications'));
  await submitTwice(newForm);
  await createdRequest;
  await page.locator('.busy-line').waitFor();
  assert.equal(creates.length, 1, 'two same-turn submit events must send one create');
  assert.match(creates[0].creationId, /^[0-9a-f-]{36}$/i);
  createGate.resolve();
  createGate = undefined;
  await counts(2, 0);
  await settle();
  assert.equal(creates.length, 1, 'no delayed second create is allowed');
  assert.equal(await newForm.getByLabel('岗位名称').inputValue(), '');
  assert.equal(await page.getByRole('article', { name: '同轮双提交岗位', exact: true }).count(), 1);
  console.log('PASS manual same-turn double-submit creates exactly one card');

  failCreate = true;
  await newForm.getByLabel('岗位名称').fill('创建失败后重试岗位');
  await newForm.getByLabel('公司名称').fill('Retry Company');
  await newForm.getByLabel('备注', { exact: true }).fill('失败不丢失输入');
  await newForm.getByRole('button', { name: '创建记录', exact: true }).click();
  await page.locator('.toast.error').filter({ hasText: '创建暂时失败，请重试' }).waitFor();
  await settle();
  assert.equal(creates.length, 2);
  assert.equal(await newForm.getByLabel('岗位名称').inputValue(), '创建失败后重试岗位');
  assert.equal(await newForm.getByLabel('公司名称').inputValue(), 'Retry Company');
  assert.equal(await newForm.getByLabel('备注', { exact: true }).inputValue(), '失败不丢失输入');
  assert.notEqual(creates[1].creationId, creates[0].creationId, 'separate successful submissions get separate identities');
  await counts(2, 0);
  failCreate = false;
  await newForm.getByRole('button', { name: '创建记录', exact: true }).click();
  await counts(3, 0);
  await settle();
  assert.equal(creates.length, 3);
  assert.equal(creates[2].creationId, creates[1].creationId, 'retry retains its logical creation identity');
  assert.equal(await newForm.getByLabel('岗位名称').inputValue(), '');
  console.log('PASS create failure preserves all inputs; retry reuses creationId');

  const activeCard = page.getByRole('article', { name: original.jobTitle, exact: true });
  await activeCard.getByRole('button', { name: '状态历史 / 面试', exact: true }).click();
  await activeCard.getByText(events[0].note, { exact: true }).waitFor();
  assert.equal(await activeCard.getByLabel('面试反馈', { exact: true }).inputValue(), interviews[0].feedback);
  await activeCard.getByRole('button', { name: '归档', exact: true }).click();
  let archiveDialog = page.getByRole('dialog', { name: '归档这条投递？', exact: true });
  await archiveDialog.waitFor();
  assert.match(await archiveDialog.textContent(), /备注、状态历史、面试与工时都会保留/);
  assert.match(await archiveDialog.textContent(), /不补发过期提醒/);
  await archiveDialog.getByRole('button', { name: '取消', exact: true }).click();
  await settle();
  assert.equal(archives.length, 0, 'cancel must never delete');
  await activeCard.waitFor();
  await counts(3, 0);
  console.log('PASS archive cancellation leaves the card active without DELETE');

  failArchive = true;
  await activeCard.getByRole('button', { name: '归档', exact: true }).click();
  archiveDialog = page.getByRole('dialog', { name: '归档这条投递？', exact: true });
  await archiveDialog.getByRole('button', { name: '确认归档', exact: true }).click();
  await archiveDialog.getByRole('status').filter({ hasText: '归档暂时失败，请重试' }).waitFor();
  await settle();
  assert.equal(archives.length, 1);
  await activeCard.waitFor();
  await counts(3, 0);
  assert.equal(await archiveDialog.getByRole('button', { name: '确认归档', exact: true }).isEnabled(), true);
  failArchive = false;
  await archiveDialog.getByRole('button', { name: '确认归档', exact: true }).click();
  await archiveDialog.waitFor({ state: 'hidden' });
  await counts(2, 1);
  await activeCard.waitFor({ state: 'hidden' });
  await stats('0', '0.0 小时', '暂无数据');
  assert.equal(archives.length, 2);
  await page.getByText('关联工时保留', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('关联投递').locator(`option[value="${applicationId}"]`).count(), 0);
  console.log('PASS archive failure stays active; retry moves the card and refreshes counts/statistics');

  await page.getByRole('button', { name: '已归档（1）', exact: true }).click();
  const archivedCard = page.getByRole('article', { name: `${original.jobTitle}（已归档）`, exact: true });
  await archivedCard.waitFor();
  await archivedCard.getByText(original.notes, { exact: true }).waitFor();
  assert.equal(await archivedCard.locator('input, textarea, select').count(), 0, 'archived cards have no editing controls');
  for (const name of ['保存备注', '记录反馈', '安排面试', '归档']) {
    assert.equal(await archivedCard.getByRole('button', { name, exact: true }).count(), 0);
  }
  await archivedCard.getByRole('button', { name: '状态历史 / 面试', exact: true }).click();
  await archivedCard.getByText(events[0].note, { exact: true }).waitFor();
  await archivedCard.getByText(interviews[0].stage, { exact: true }).waitFor();
  await archivedCard.getByText('结果：通过 · 面试反馈保留', { exact: true }).waitFor();
  assert.equal(await archivedCard.locator('input, textarea, select').count(), 0, 'expanded archived history is read-only');
  await mkdir(new URL('./.artifacts/', import.meta.url), { recursive: true });
  await page.screenshot({ path: fileURLToPath(new URL('./.artifacts/tracking-recovery-archived.png', import.meta.url)), fullPage: true });
  console.log('PASS archived notes, feedback, interview history and work hours remain visible and read-only');

  failRestore = true;
  await archivedCard.getByRole('button', { name: '恢复投递', exact: true }).click();
  await archivedCard.getByRole('status').filter({ hasText: '恢复暂时失败，请重试' }).waitFor();
  await settle();
  await counts(2, 1);
  await archivedCard.waitFor();
  assert.equal(restores.length, 1);
  assert.equal(restores[0].baseVersion, 2);
  assert.equal(await archivedCard.getByRole('button', { name: '恢复投递', exact: true }).isEnabled(), true);
  failRestore = false;
  await archivedCard.getByRole('button', { name: '恢复投递', exact: true }).click();
  await counts(3, 0);
  await archivedCard.waitFor({ state: 'hidden' });
  await page.getByText('暂无归档记录。归档的投递会保存在这里，可随时恢复。', { exact: true }).waitFor();
  await stats('1', '2.0 小时', '5.0');
  assert.equal(restores.length, 2);
  assert.deepEqual(restores[1], restores[0], 'restore retry retains the archived baseVersion');
  await page.getByRole('button', { name: '未归档（3）', exact: true }).click();
  await activeCard.waitFor();
  assert.equal(await activeCard.getByLabel('投递备注').inputValue(), original.notes);
  assert.equal(await activeCard.getByLabel('投递状态').isEnabled(), true);
  await activeCard.getByRole('button', { name: '状态历史 / 面试', exact: true }).click();
  await activeCard.getByText(events[0].note, { exact: true }).waitFor();
  assert.equal(await activeCard.getByLabel('面试反馈', { exact: true }).inputValue(), interviews[0].feedback);
  assert.equal(await page.getByLabel('关联投递').locator(`option[value="${applicationId}"]`).count(), 1);
  console.log('PASS restore failure stays archived; retry restores editable card, history and statistics');

  await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '岗位库', exact: true }).click();
  const jobCard = page.locator('.job-card').filter({ hasText: jobs[0].title });
  await jobCard.getByRole('button', { name: '查看条件', exact: true }).click();
  const jobDialog = page.getByRole('dialog', { name: '岗位详情', exact: true });
  await jobDialog.getByRole('heading', { name: jobs[0].title, exact: true }).waitFor();
  createGate = deferred();
  const jobRequest = page.waitForRequest((request) => request.method() === 'POST' && request.url().endsWith('/applications'));
  await page.evaluate(() => {
    const listButton = [...document.querySelectorAll('.job-card button')].find((button) => button.textContent === '加入投递跟踪');
    const detailButton = [...document.querySelectorAll('[role="dialog"] button')].find((button) => button.textContent === '加入投递跟踪');
    // Both mounted entry points are dispatched synchronously before awaiting React.
    for (const button of [listButton, detailButton, listButton, detailButton]) {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    }
  });
  await jobRequest;
  await jobDialog.getByRole('button', { name: '正在加入…', exact: true }).waitFor();
  assert.equal(creates.length, 4, 'list and detail must share one creation guard');
  assert.equal(await jobCard.getByRole('button', { name: '正在加入…', exact: true }).isDisabled(), true);
  createGate.resolve();
  createGate = undefined;
  await jobDialog.getByRole('button', { name: '已加入投递跟踪', exact: true }).waitFor();
  await settle();
  assert.equal(creates.length, 4);
  assert.equal(creates[3].jobId, jobs[0].id);
  assert.equal(await jobDialog.getByRole('button', { name: '已加入投递跟踪', exact: true }).isDisabled(), true);
  assert.equal(await jobCard.getByRole('button', { name: '已加入投递跟踪', exact: true }).isDisabled(), true);
  await jobDialog.getByRole('button', { name: '关闭', exact: true }).click();
  await jobCard.getByRole('button', { name: '查看条件', exact: true }).click();
  await jobDialog.getByRole('button', { name: '已加入投递跟踪', exact: true }).waitFor();
  assert.equal(await jobDialog.getByRole('button', { name: '已加入投递跟踪', exact: true }).isDisabled(), true);
  await jobDialog.getByRole('button', { name: '关闭', exact: true }).click();
  console.log('PASS Jobs list/detail share a pending guard and retain the completed state on reopen');

  const retryJobCard = page.locator('.job-card').filter({ hasText: jobs[1].title });
  failCreate = true;
  await retryJobCard.getByRole('button', { name: '加入投递跟踪', exact: true }).click();
  await page.locator('.toast.error').filter({ hasText: '创建暂时失败，请重试' }).waitFor();
  await settle();
  assert.equal(creates.length, 5);
  assert.equal(await retryJobCard.getByRole('button', { name: '加入投递跟踪', exact: true }).isEnabled(), true);
  await retryJobCard.getByRole('button', { name: '查看条件', exact: true }).click();
  await jobDialog.getByRole('heading', { name: jobs[1].title, exact: true }).waitFor();
  failCreate = false;
  await jobDialog.getByRole('button', { name: '加入投递跟踪', exact: true }).click();
  await jobDialog.getByRole('button', { name: '已加入投递跟踪', exact: true }).waitFor();
  await settle();
  assert.equal(creates.length, 6);
  assert.equal(creates[5].creationId, creates[4].creationId, 'retry from detail reuses the failed list attempt identity');
  assert.equal(creates[5].jobId, jobs[1].id);
  assert.equal(await retryJobCard.getByRole('button', { name: '已加入投递跟踪', exact: true }).isDisabled(), true);
  await jobDialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '投递跟踪', exact: true }).click();
  await counts(5, 0);
  await settle();
  for (const job of jobs) assert.equal(await page.getByRole('article', { name: job.title, exact: true }).count(), 1);
  assert.deepEqual(unexpected, [], 'all API requests must be explicitly mocked');
  assert.deepEqual(pageErrors, [], 'the UI must not throw uncaught browser errors');
  console.log('PASS Jobs list failure can retry in detail with the same creationId and exactly one card');
  console.log('PASS tracking-recovery: all mocked browser regressions passed');
} catch (error) {
  if (page) {
    const artifacts = new URL('./.artifacts/', import.meta.url);
    await mkdir(artifacts, { recursive: true });
    await page.screenshot({ path: fileURLToPath(new URL('tracking-recovery-failure.png', artifacts)), fullPage: true }).catch(() => {});
    console.error('Browser page errors:', pageErrors);
    console.error('Unexpected API requests:', unexpected);
  }
  throw error;
} finally {
  createGate?.resolve();
  await browser?.close();
  await server?.close();
}
