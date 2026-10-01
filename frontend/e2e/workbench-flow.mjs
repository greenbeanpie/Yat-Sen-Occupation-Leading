// 端到端联调：需要先启动 backend（npm run dev）与 frontend（npm run dev）。
// 运行：node e2e/workbench-flow.mjs
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_URL, chromiumExecutable, loadPlaywright } from './playwright-runtime.mjs';

const playwright = await loadPlaywright();
const { chromium } = playwright;
const EXE = chromiumExecutable();
const BASE = BASE_URL;
const RUN = Date.now().toString(36);
const ARTIFACTS = fileURLToPath(new URL('./.artifacts/', import.meta.url));
await mkdir(ARTIFACTS, { recursive: true });

const calls = [];
const syncBodies = [];
const consoleErrors = [];
const results = [];

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` :: ${detail}` : ''}`);
}

async function step(name, body) {
  try {
    const detail = await body();
    record(name, true, detail ?? '');
  } catch (error) {
    const message = error instanceof Error ? error.message.split('\n').slice(0, 3).join(' | ') : String(error);
    record(name, false, message);
  }
}

async function selectByText(select, needle) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const index = await select.evaluate(
      (element, text) => [...element.options].findIndex((option) => option.textContent.includes(text)),
      needle,
    );
    if (index >= 0) return select.selectOption({ index });
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const options = await select.evaluate((element) => [...element.options].map((option) => option.textContent));
  throw new Error(`下拉框没有包含「${needle}」的选项，现有：${JSON.stringify(options)}`);
}

async function waitForCall(method, pattern, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const hit = calls.find((call) => call.method === method && pattern.test(call.path) && call.status >= 200 && call.status < 300);
    if (hit) return hit;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`未观察到成功的 ${method} ${pattern} 请求`);
}

async function waitForText(page, pattern, timeout = 20000) {
  await page.getByText(pattern).first().waitFor({ state: 'visible', timeout });
}

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

page.on('response', (response) => {
  const url = response.url();
  if (!url.includes('/api/v1')) return;
  const parsed = new URL(url);
  calls.push({ method: response.request().method(), path: parsed.pathname.replace('/api/v1', '') + parsed.search, status: response.status() });
  if (parsed.pathname.endsWith('/sync/operations') && response.ok()) {
    response.json().then((body) => syncBodies.push(body)).catch(() => {});
  }
});
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});
page.on('pageerror', (error) => consoleErrors.push(`PAGEERROR ${error.message}`));

function panel(title) {
  return page.locator('section.panel').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
}

async function goNav(label) {
  // 导航项在有离线操作时会追加角标数字，所以按前缀匹配。
  await page.getByRole('link', { name: new RegExp(`^${label}`) }).first().click();
}

// ---------------------------------------------------------------- 账号注册与凭据登录
const accountName = `e2e_${RUN}`;
const accountSecret = ['e2e', 'passphrase', RUN].join('-');
await page.goto(BASE, { waitUntil: 'networkidle' });
await step('账号：注册新账号并自动进入工作台（POST /session/register）', async () => {
  await page.getByRole('link', { name: '注册新账号' }).click();
  await page.getByLabel('用户名').fill(accountName);
  await page.getByLabel('昵称（可选）').fill('联调账号');
  await page.getByLabel('密码', { exact: true }).fill(accountSecret);
  await page.getByLabel('确认密码').fill(accountSecret);
  await page.getByRole('button', { name: '注册并进入' }).click();
  const call = await waitForCall('POST', /^\/session\/register$/);
  await waitForText(page, /早上好/);
  return `${call.status}，已进入 ${(await page.locator('.who b').innerText()).trim()}`;
});

await step('账号：登出后用账号密码重新登录（POST /session/login）', async () => {
  await page.getByRole('button', { name: '退出登录' }).click();
  await waitForText(page, '进入实习工作台');
  await page.getByLabel('用户名').fill(accountName);
  await page.getByLabel('密码', { exact: true }).fill(accountSecret);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  const call = await waitForCall('POST', /^\/session\/login$/);
  await waitForText(page, /早上好/);
  const display = (await page.locator('.who b').innerText()).trim();
  if (display !== '联调账号') throw new Error(`昵称未保留：${display}`);
  return `${call.status}，昵称 ${display}`;
});

await step('账号：登出后进入演示模式临时入口，再退出回正式登录页', async () => {
  await page.getByRole('button', { name: '退出登录' }).click();
  await waitForText(page, '进入实习工作台');
  await page.getByRole('button', { name: /体验演示模式/ }).click();
  await waitForText(page, '这里是演示模式');
  await page.getByRole('button', { name: /演示学生/ }).first().click();
  await waitForText(page, /早上好/);
  const indicator = (await page.locator('.api-indicator').innerText()).trim();
  if (!indicator.includes('内置演示数据源')) throw new Error(`未切到演示数据源：${indicator}`);
  await page.getByRole('button', { name: '退出登录' }).click();
  await waitForText(page, '注册或登录你的账号开始使用');
  return '演示模式往返 OK';
});

// 后续步骤沿用演示身份（内置演示数据源）。
await page.goto(BASE, { waitUntil: 'networkidle' });
await step('登录：选择演示学生身份', async () => {
  await page.getByRole('button', { name: /演示学生/ }).first().click();
  await waitForText(page, /早上好/);
  return '工作台已渲染';
});

// ------------------------------------------------------- 画像保存
const roleTitle = `数据分析实习生 ${RUN}`;
await step('画像：保存求职偏好（PUT /profile）', async () => {
  await goNav('求职资料');
  await waitForText(page, '你的求职画像');
  const form = page.locator('form.form-grid').first();
  await form.getByLabel('目标岗位（逗号分隔）').fill(roleTitle);
  await form.getByLabel('目标行业（逗号分隔）').fill('互联网');
  await form.getByLabel('毕业年份').fill('2027');
  await form.getByLabel('学历').selectOption('bachelor');
  await form.getByLabel('期望地点（逗号分隔）').fill('广州');
  await form.getByLabel('每周求职时间（小时）').fill('8');
  const requirement = await form.evaluate((element) => element.checkValidity());
  if (!requirement) throw new Error('表单仍被浏览器校验拦截');
  await form.getByRole('button', { name: '保存画像' }).click();
  const call = await waitForCall('PUT', /^\/profile$/);
  return `${call.status} PUT /profile`;
});

// ------------------------------------------------------- 经历与技能
const experienceTitle = `校园二手交易平台数据分析 ${RUN}`;
await step('经历：新增一段经历（POST /evidence/experiences）', async () => {
  const target = panel('经历');
  const form = target.locator('form.form-grid');
  await form.getByLabel('经历标题').fill(experienceTitle);
  await form.getByLabel('组织 / 公司').fill('中山大学数据科学学院');
  await form.getByLabel('类型').selectOption('project');
  await form.getByLabel('开始日期').fill('2025-03-01');
  await form.getByLabel('结束日期').fill('2025-06-30');
  await form.getByLabel('经历原文描述').fill('使用 SQL 清洗 3 万条订单数据，搭建看板后把周报整理时间从 6 小时降到 1 小时。');
  await form.getByRole('button', { name: '添加经历' }).click();
  const call = await waitForCall('POST', /^\/evidence\/experiences$/);
  await target.getByText(experienceTitle).first().waitFor({ state: 'visible', timeout: 15000 });
  return `${call.status}，列表已显示新经历`;
});

await step('技能：新增技能（POST /evidence/skills）', async () => {
  const target = panel('技能证据');
  const form = target.locator('form.form-grid').first();
  await form.getByLabel('技能名称').fill('SQL');
  await form.getByRole('button', { name: '添加技能' }).click();
  const call = await waitForCall('POST', /^\/evidence\/skills$/);
  await target.getByText('SQL').first().waitFor({ state: 'visible', timeout: 15000 });
  return `${call.status}`;
});

await step('证据：建立技能与经历原文的引用并确认', async () => {
  const target = panel('技能证据');
  const form = target.locator('form.form-grid').nth(1);
  await form.getByLabel('关联技能').selectOption({ label: 'SQL' });
  await form.getByLabel('关联经历').selectOption({ label: `${experienceTitle} · 中山大学数据科学学院` });
  await form.getByLabel('经历原文摘录').fill('使用 SQL 清洗 3 万条订单数据');
  await form.getByRole('button', { name: '添加引用' }).click();
  const created = await waitForCall('POST', /^\/evidence\/links$/);
  await target.getByRole('button', { name: '确认' }).first().click();
  const confirmed = await waitForCall('PUT', /^\/evidence\/links\//);
  await target.getByText('confirmed').first().waitFor({ state: 'visible', timeout: 15000 });
  return `${created.status} 创建 / ${confirmed.status} 确认`;
});

// ------------------------------------------------------- 简历导入（documents 流水线）
function buildMinimalPdf(textLines) {
  const escapePdf = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const contentText = textLines
    .map((line, i) => `BT /F1 12 Tf 72 ${720 - i * 20} Td (${escapePdf(line)}) Tj ET`)
    .join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${contentText.length} >>\nstream\n${contentText}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((obj, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

const resumePdfPath = path.join(ARTIFACTS, `resume-${RUN}.pdf`);
await writeFile(resumePdfPath, buildMinimalPdf([
  'Resume',
  `Data Analysis Candidate ${RUN}`,
  'Skilled in SQL and Python data cleaning, built dashboards for weekly reports.',
]));

await step('简历：上传 PDF 并等待解析草稿（POST /documents）', async () => {
  await goNav('求职资料');
  await waitForText(page, '简历导入');
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 15000 }),
    page.getByRole('button', { name: /选择 PDF 或 DOCX 简历/ }).click(),
  ]);
  await chooser.setFiles(resumePdfPath);
  await page.getByRole('button', { name: '上传并解析' }).click();
  const upload = await waitForCall('POST', /^\/documents$/);
  await waitForCall('POST', /^\/documents\/[^/]+\/parse$/);
  await waitForCall('GET', /^\/documents\/[^/]+\/draft$/);
  await waitForText(page, '解析草稿');
  return `${upload.status}，草稿已就绪`;
});

await step('简历：确认解析结果写入画像（POST /documents/{id}/confirm）', async () => {
  await page.getByLabel('我已核对以上内容，确认写入画像').check();
  await page.getByRole('button', { name: '确认解析结果' }).click();
  const call = await waitForCall('POST', /^\/documents\/[^/]+\/confirm$/);
  return `${call.status} confirm`;
});

// ------------------------------------------------------- 岗位
const jobTitle = `数据分析实习生（增长方向）${RUN}`;
await step('岗位：粘贴私人 JD（POST /jobs）', async () => {
  await goNav('岗位库');
  await waitForText(page, '找到值得准备的机会');
  await page.getByRole('button', { name: '添加私人 JD' }).click();
  const modal = page.locator('section.modal');
  await modal.getByLabel('岗位名称').fill(jobTitle);
  await modal.getByLabel('公司名称').fill('广州橙子科技有限公司');
  await modal.getByLabel('工作地点').fill('广州');
  await modal.getByLabel('截止日期').fill('2026-11-30');
  await modal.getByLabel('来源链接').fill('https://example.com/jobs/data-analyst-growth');
  await modal.getByLabel('JD 原文').fill(
    '岗位职责：负责增长业务的数据分析，搭建指标体系并输出周报。任职要求：本科及以上在读，2026 至 2028 年毕业；熟练使用 SQL 完成数据提取；掌握 Excel 与可视化工具；每周可投入 8 小时以上。',
  );
  await modal.getByRole('button', { name: '保存岗位' }).click();
  const call = await waitForCall('POST', /^\/jobs$/);
  await page.getByText(jobTitle).first().waitFor({ state: 'visible', timeout: 15000 });
  return `${call.status}`;
});

await step('岗位：解析要求草稿并确认（操作作业 + 确认）', async () => {
  const card = page.locator('article.job-card.private-job-card').filter({ hasText: jobTitle });
  await card.getByRole('button', { name: '解析要求' }).click();
  await waitForCall('POST', /^\/jobs\/[0-9a-f-]+\/parse-requirements$/);
  await waitForCall('GET', /^\/operations\//);
  const draft = card.locator('div.draft-review');
  await draft.getByText('候选岗位要求').waitFor({ state: 'visible', timeout: 60000 });
  await draft.getByRole('button', { name: '确认这些要求' }).click();
  const call = await waitForCall('POST', /^\/jobs\/[0-9a-f-]+\/requirements\/confirm$/);
  return `${call.status} 已确认候选要求`;
});

await step('岗位详情：查看已确认条件与 JD 原文', async () => {
  const card = page.locator('article.job-card.private-job-card').filter({ hasText: jobTitle });
  await card.getByRole('button', { name: '查看 JD 与条件' }).click();
  const modal = page.locator('section.modal');
  await modal.getByRole('heading', { name: jobTitle }).waitFor({ state: 'visible', timeout: 15000 });
  const conditions = await modal.locator('ul.requirement-list li').count();
  await modal.getByRole('button', { name: '关闭' }).click();
  if (conditions === 0) throw new Error('岗位详情没有已确认条件');
  return `${conditions} 项条件`;
});

// ------------------------------------------------------- 匹配与组合
await step('匹配：生成解释（硬条件、分项分数、引用）', async () => {
  await goNav('匹配与组合');
  await waitForText(page, '看清条件、差距和准备成本');
  const target = panel('生成匹配解释');
  await selectByText(target.getByLabel('选择岗位'), RUN);
  await target.getByRole('button', { name: '开始分析' }).click();
  await waitForCall('POST', /^\/matches$/);
  await target.locator('section.match-result').waitFor({ state: 'visible', timeout: 90000 });
  const text = await target.innerText();
  for (const keyword of ['硬条件', '技能覆盖', '已确认经历证据', '岗位与偏好', '引用依据']) {
    if (!text.includes(keyword)) throw new Error(`匹配解释缺少「${keyword}」`);
  }
  return '解释含硬条件与三项分项分数';
});

await step('组合：按每周预算生成求职组合（POST /portfolios）', async () => {
  const target = panel('求职组合');
  await target.getByLabel('每周准备预算（小时）').fill('8');
  await target.getByRole('button', { name: /生成组合|更新组合/ }).click();
  const call = await waitForCall('POST', /^\/portfolios$/, 20000).catch(() => waitForCall('PUT', /^\/portfolios\//, 20000));
  await target.getByText(/组合预算：/).first().waitFor({ state: 'visible', timeout: 20000 });
  return `${call.method} ${call.path} ${call.status}`;
});

// ------------------------------------------------------- 计划与改写
await step('计划：生成两周计划草稿（POST /plans + 作业轮询）', async () => {
  await goNav('计划与改写');
  await waitForText(page, '把组合变成两周行动');
  const target = panel('生成计划草稿');
  await target.getByRole('button', { name: '生成两周计划' }).click();
  try {
    await waitForCall('POST', /^\/plans$/);
  } catch (error) {
    const notice = await page.locator('.inline-error, .toast').allInnerTexts();
    throw new Error(`${error.message}；页面提示：${notice.join(' | ')}`);
  }
  await page.getByText('计划状态：待确认草稿').first().waitFor({ state: 'visible', timeout: 90000 });
  return '草稿已生成并等待确认';
});

await step('计划：确认草稿（POST /plans/{id}/confirm）', async () => {
  const target = panel('两周任务与排期');
  const tasks = await target.locator('article.task-card').count();
  await target.getByRole('button', { name: '确认计划' }).click();
  const call = await waitForCall('POST', /^\/plans\/[0-9a-f-]+\/confirm$/);
  await page.getByText('计划状态：已确认').first().waitFor({ state: 'visible', timeout: 20000 });
  return `${call.status}，任务数 ${tasks}`;
});

await step('任务：更新状态与实际耗时（PATCH /tasks/{id}）', async () => {
  const target = panel('两周任务与排期');
  const form = target.locator('article.task-card form.form-grid').first();
  await form.getByLabel('实际小时').fill('2');
  await form.getByLabel('状态').selectOption('done');
  await form.getByRole('button', { name: '保存任务' }).click();
  const call = await waitForCall('PATCH', /^\/tasks\/[0-9a-f-]+$/);
  return `${call.status}`;
});

await step('计划：任务卡显示关联岗位、已确认证据与依赖任务', async () => {
  const target = panel('两周任务与排期');
  await target.getByText(/关联岗位：/).first().waitFor({ state: 'visible', timeout: 20000 });
  const text = await target.innerText();
  for (const keyword of ['关联岗位：', '已确认证据：', '依赖任务：']) {
    if (!text.includes(keyword)) throw new Error(`任务卡缺少「${keyword}」`);
  }
  return '任务卡包含岗位、证据与依赖关系';
});

await step('改写：生成逐条建议（POST /rewrites）', async () => {
  const target = panel('简历改写建议');
  await target.getByRole('button', { name: '生成改写' }).first().click();
  await waitForCall('POST', /^\/rewrites$/);
  await target.getByText('改写对照').waitFor({ state: 'visible', timeout: 90000 });
  const items = await target.locator('article.rewrite-item').count();
  return `${items} 条建议`;
});

// ------------------------------------------------------- 投递与工时
const applicationTitle = `数据分析实习生 ${RUN}`;
await step('投递：创建投递记录（POST /applications）', async () => {
  await goNav('投递跟踪');
  await waitForText(page, '记录每次行动与反馈');
  const target = panel('新增投递和记录工时');
  await target.getByLabel('岗位名称').fill(applicationTitle);
  await target.getByLabel('公司名称').fill('广州橙子科技有限公司');
  await target.getByLabel('备注').fill('由端到端验证脚本创建');
  await target.getByRole('button', { name: '创建记录' }).click();
  const call = await waitForCall('POST', /^\/applications$/);
  await page.getByText(applicationTitle).first().waitFor({ state: 'visible', timeout: 15000 });
  return `${call.status}`;
});

await step('工时：记录实际投入（POST /time-entries）', async () => {
  const target = panel('新增投递和记录工时');
  await target.getByLabel('投入分钟').fill('90');
  await target.getByLabel('日期').fill(new Date().toISOString().slice(0, 10));
  await target.getByLabel('说明').fill('整理岗位要求与简历匹配点');
  await target.getByRole('button', { name: '记录工时' }).click();
  const call = await waitForCall('POST', /^\/time-entries$/);
  await panel('实际工时').getByText('90 分钟').first().waitFor({ state: 'visible', timeout: 15000 });
  return `${call.status}`;
});

await step('统计：按所选区间展示面试数与实际投入', async () => {
  const text = await page.locator('div.stats').first().innerText();
  if (!text.includes('每 10 小时面试数')) throw new Error('统计卡片缺失');
  const hours = Number((text.match(/实际投入\s*([0-9.]+) 小时/) ?? [])[1] ?? NaN);
  if (!(hours > 0)) throw new Error(`实际投入未累计：${text.replace(/\n+/g, ' | ')}`);
  const efficiency = text.includes('暂无数据') ? '零面试时显示暂无数据' : '已按去重面试投递计算效率';
  return `实际投入 ${hours} 小时；${efficiency}`;
});

await step('投递：推进状态并写入历史（POST /applications/{id}/events）', async () => {
  const card = page.locator('article.application-card').filter({ hasText: applicationTitle }).first();
  const statusSelect = card.locator('select').first();
  await statusSelect.selectOption('submitted');
  const call = await waitForCall('POST', /^\/applications\/[0-9a-f-]+\/events$/);
  return `${call.status}`;
});

// ------------------------------------------------------- 设置与同步
await step('离线：断网保存画像进入本机队列', async () => {
  await page.context().setOffline(true);
  await goNav('求职资料');
  await waitForText(page, '你的求职画像');
  const form = page.locator('form.form-grid').first();
  await form.getByLabel('目标岗位（逗号分隔）').fill(`${roleTitle} 离线修订`);
  await form.getByRole('button', { name: '保存画像' }).click();
  await page.getByText(/已写入本机队列/).first().waitFor({ state: 'visible', timeout: 20000 });
  await page.getByText(/待同步/).first().waitFor({ state: 'visible', timeout: 15000 });
  const offlineNotice = await page.locator('.sync-pill').first().innerText();
  return offlineNotice.trim();
});

await step('离线：切换页面后仍显示本机缓存内容', async () => {
  await goNav('工作台');
  await waitForText(page, /早上好/);
  await goNav('求职资料');
  await page.getByText(/当前显示本机上次同步的数据/).first().waitFor({ state: 'visible', timeout: 20000 });
  const value = await page.locator('form.form-grid').first().getByLabel('目标岗位（逗号分隔）').inputValue();
  if (!value.includes('离线修订')) throw new Error(`本机缓存未保留离线修改：${value}`);
  return `缓存值 = ${value}`;
});

await step('同步：恢复网络后提交离线操作（POST /sync/operations）', async () => {
  await goNav('设置');
  await page.getByRole('navigation', { name: '设置分类' }).getByRole('link', { name: '外观与通知', exact: true }).click();
  await waitForText(page, '同步、提醒与离线状态');
  const target = panel('离线同步');
  await page.context().setOffline(false);
  await target.getByRole('button', { name: '立即同步' }).click();
  await waitForCall('POST', /^\/sync\/operations$/, 30000).catch(() => null);
  await page.getByText(/同步完成：/).first().waitFor({ state: 'visible', timeout: 20000 });
  const summary = (await page.getByText(/同步完成：/).first().innerText()).trim();
  const statuses = syncBodies.flatMap((body) => (body.results ?? []).map((result) => `${result.opId.slice(0, 8)}=${result.status}`));
  if (!statuses.length) throw new Error('同步没有回执');
  const applied = syncBodies.flatMap((body) => body.results ?? []).filter((result) => result.status === 'applied' || result.status === 'duplicate').length;
  if (applied === 0) throw new Error(`同步回执没有落地：${JSON.stringify(statuses)}`);
  return `${summary}；回执 ${statuses.join(', ')}`;
});

await step('同步：同一 opId 重复提交返回 duplicate 而不是重复写入', async () => {
  const outcome = await page.evaluate(async (suffix) => {
    const operation = {
      opId: crypto.randomUUID(),
      entityId: crypto.randomUUID(),
      entity: 'skill',
      baseVersion: 0,
      action: 'upsert',
      payload: { name: `幂等验证技能 ${suffix}` },
    };
    const push = async () => {
      const response = await fetch('/api/v1/sync/operations', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operations: [operation] }),
      });
      return response.json();
    };
    const first = await push();
    const second = await push();
    return {
      entityId: operation.entityId,
      first: first.results[0],
      second: second.results[0],
    };
  }, RUN);
  if (outcome.first.status !== 'applied') throw new Error(`首次提交未落地：${JSON.stringify(outcome.first)}`);
  if (outcome.second.status !== 'duplicate') throw new Error(`重复提交未去重：${JSON.stringify(outcome.second)}`);
  const changes = await page.evaluate(async (entityId) => {
    const response = await fetch('/api/v1/sync/changes?since=0&limit=500', { credentials: 'include' });
    const body = await response.json();
    return (body.changes ?? []).filter((change) => change.entityId === entityId).length;
  }, outcome.entityId);
  if (changes !== 1) throw new Error(`同一操作写入 ${changes} 条变更日志`);
  return `applied → duplicate，变更日志 ${changes} 条`;
});

await step('设置：提醒设置与站内提醒面板可用', async () => {
  const target = panel('提醒设置');
  await target.getByRole('button', { name: '保存提醒设置' }).click();
  const call = await waitForCall('PUT', /^\/notifications\/settings$/);
  const notices = await panel('站内提醒').innerText();
  return `${call.status}；站内提醒面板：${notices.split('\n')[0]}`;
});

// ------------------------------------------------------- 管理员
await step('管理员：切换身份后维护公共岗位', async () => {
  await page.locator('.who button.icon-btn').click();
  await page.getByRole('heading', { name: '进入实习工作台' }).waitFor({ state: 'visible', timeout: 20000 });
  await page.getByRole('button', { name: /管理员/ }).first().click();
  let body = '';
  for (let attempt = 0; attempt < 60; attempt += 1) {
    body = await page.locator('body').innerText();
    if (body.includes('管理员身份')) break;
    await page.waitForTimeout(500);
  }
  if (!body.includes('管理员身份')) {
    throw new Error(`管理员登录后没有进入工作台：${body.replace(/\s+/g, ' ').slice(0, 300)}`);
  }
  await goNav('公共岗位管理');
  await waitForText(page, '公共岗位管理');
  await waitForCall('GET', /^\/admin\/jobs$/);
  const text = await panel('公共岗位').innerText();
  return text.split('\n').slice(0, 2).join(' / ');
});

await step('设置：重置演示数据（POST /demo/reset）并清空本机缓存', async () => {
  await page.locator('.who button.icon-btn').click();
  await page.getByRole('heading', { name: '进入实习工作台' }).waitFor({ state: 'visible', timeout: 20000 });
  await page.getByRole('button', { name: /演示学生/ }).first().click();
  await goNav('设置');
  await page.getByRole('navigation', { name: '设置分类' }).getByRole('link', { name: '外观与通知', exact: true }).click();
  await waitForText(page, '同步、提醒与离线状态');
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: '重置我的演示数据' }).click();
  const call = await waitForCall('POST', /^\/demo\/reset$/);
  await page.getByText(/已清空服务端/).first().waitFor({ state: 'visible', timeout: 20000 });
  await goNav('求职资料');
  await waitForText(page, '你的求职画像');
  const value = await page.locator('form.form-grid').first().getByLabel('目标岗位（逗号分隔）').inputValue();
  if (value.trim() !== '') throw new Error(`重置后画像仍有内容：${value}`);
  const jobs = await page.evaluate(async () => {
    const response = await fetch('/api/v1/jobs?scope=mine', { credentials: 'include' });
    return (await response.json()).items.length;
  });
  return `${call.status}；画像已清空，私人岗位剩余 ${jobs}`;
});

await page.screenshot({ path: `${ARTIFACTS}final-admin.png`, fullPage: false });

const failed = results.filter((result) => !result.ok);
console.log('\n================ 汇总 ================');
console.log(`通过 ${results.length - failed.length}/${results.length}`);
const unexpected = consoleErrors.filter((text) => !/favicon|Manifest|Download the React DevTools/i.test(text));
if (unexpected.length) console.log('控制台错误:', JSON.stringify(unexpected.slice(0, 8), null, 2));
console.log(`API 调用数: ${calls.length}`);
if (failed.length) console.log('失败步骤:', JSON.stringify(failed, null, 2));

await browser.close();
process.exit(failed.length ? 1 : 0);
