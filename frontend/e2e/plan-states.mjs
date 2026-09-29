// 计划要求的错误态与边界状态验收（PLAN.md 第 5 节）：
// 解析失败、引用缺失、硬条件未知、岗位下架、旧计划被替代、零工时。
// 运行前先启动演示数据源：npm run dev:demo（默认 5174 端口）。
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromiumExecutable, loadPlaywright } from './playwright-runtime.mjs';

const playwright = await loadPlaywright();
const { chromium } = playwright;
const BASE = process.env.WORKBENCH_URL ?? 'http://127.0.0.1:5174';
const ARTIFACTS = fileURLToPath(new URL('./.artifacts/', import.meta.url));
await mkdir(ARTIFACTS, { recursive: true });

const results = [];
const calls = [];

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` :: ${detail}` : ''}`);
}

async function step(name, body) {
  try {
    record(name, true, (await body()) ?? '');
  } catch (error) {
    record(name, false, error instanceof Error ? error.message.split('\n')[0] : String(error));
  }
}

const browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.on('response', (response) => {
  const url = response.url();
  if (!url.includes('/api/v1')) return;
  const parsed = new URL(url);
  calls.push({ method: response.request().method(), path: parsed.pathname.replace('/api/v1', ''), status: response.status() });
});

function panel(title) {
  return page.locator('section.panel').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
}

async function goNav(label) {
  await page.getByRole('link', { name: new RegExp(`^${label}`) }).first().click();
}

async function login(name) {
  await page.getByRole('button', { name }).first().click();
  await page.locator('.who').first().waitFor({ state: 'visible', timeout: 20000 });
}

async function logout() {
  await page.locator('.who button.icon-btn').click();
  await page.getByRole('heading', { name: '进入实习工作台' }).waitFor({ state: 'visible', timeout: 20000 });
}

await page.goto(BASE, { waitUntil: 'networkidle' });

// 1. 岗位下架：归档岗位只对管理员可见
await step('岗位下架：归档岗位不进入学生公共库', async () => {
  await login(/演示管理员/);
  await goNav('管理员岗位');
  await page.getByText('维护公共岗位').first().waitFor({ state: 'visible', timeout: 20000 });
  const archived = page.locator('article.admin-job').filter({ hasText: 'archived' }).first();
  const title = (await archived.locator('.row-title').first().innerText()).split('\n')[0].trim();
  await logout();
  await login(/演示学生/);
  await goNav('岗位库');
  await page.getByText('找到值得准备的机会').first().waitFor({ state: 'visible', timeout: 20000 });
  const publicText = await panel('公共岗位库').innerText();
  if (!title) throw new Error('未在管理员列表中找到已归档岗位');
  if (publicText.includes(title)) throw new Error(`已归档岗位「${title}」仍出现在学生公共库`);
  return `归档岗位「${title}」对学生不可见`;
});

// 2. 引用缺失：quote 未命中经历原文
await step('引用缺失：原文未命中时返回 quote_rejected 并提示', async () => {
  await goNav('画像与证据');
  await page.getByText('你的求职画像').first().waitFor({ state: 'visible', timeout: 20000 });
  const target = panel('技能证据');
  const form = target.locator('form.form-grid').nth(1);
  await form.getByLabel('关联技能').selectOption({ index: 0 });
  await form.getByLabel('关联经历').selectOption({ index: 0 });
  await form.getByLabel('经历原文摘录').fill('这段文字并不存在于任何经历原文中');
  const before = await target.locator('article.quote-card').count();
  await form.getByRole('button', { name: '添加引用' }).click();
  await page.locator('.toast.error').first().waitFor({ state: 'visible', timeout: 20000 });
  const toast = await page.locator('.toast.error').first().innerText();
  if (!/引用/.test(toast)) throw new Error(`错误提示未说明引用问题：${toast}`);
  const after = await target.locator('article.quote-card').count();
  if (after !== before) throw new Error('未命中原文的引用不应写入证据列表');
  return toast.trim().slice(0, 60);
});

// 3. 解析失败：非示例文件必须明确失败
await step('解析失败：上传非示例文件不返回固定成功结果', async () => {
  const target = panel('简历导入');
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    target.getByRole('button', { name: /选择 PDF 或 DOCX 简历/ }).click(),
  ]);
  await chooser.setFiles({ name: '无关文件.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 demo') });
  await target.getByRole('button', { name: '上传并解析' }).click();
  await page.locator('.toast.error').first().waitFor({ state: 'visible', timeout: 30000 });
  const toast = await page.locator('.toast.error').first().innerText();
  const draft = await target.locator('.draft-review').count();
  if (draft > 0) throw new Error('非示例文件却出现了可确认草稿');
  if (!/示例简历|解析|提取/.test(toast)) throw new Error(`错误提示不符合预期：${toast}`);
  return toast.trim().slice(0, 60);
});

// 4. 硬条件未知：画像缺少意向地点时不按通过处理
await step('硬条件未知：画像缺项时保留 unknown 并说明覆盖范围', async () => {
  await goNav('画像与证据');
  const profileForm = page.locator('form.form-grid').first();
  await profileForm.getByLabel('期望地点（逗号分隔）').fill('');
  await profileForm.getByRole('button', { name: '保存画像' }).click();
  await page.locator('.toast').first().waitFor({ state: 'visible', timeout: 20000 });

  await goNav('匹配与组合');
  await page.getByText('看清条件、差距和准备成本').first().waitFor({ state: 'visible', timeout: 20000 });
  const target = panel('生成匹配解释');
  await target.getByLabel('选择岗位').selectOption({ index: 1 });
  await target.getByRole('button', { name: '开始分析' }).click();
  await target.locator('section.match-result').waitFor({ state: 'visible', timeout: 60000 });
  const text = await target.locator('section.match-result').innerText();
  if (!text.includes('硬条件')) throw new Error('匹配解释缺少硬条件');
  if (!text.includes('unknown')) throw new Error(`未出现未知状态：${text.slice(0, 120)}`);
  if (!/未填写|待核实|人工核实/.test(text)) throw new Error('未知状态没有说明原因');
  return '匹配解释保留 unknown 与人工核实说明';
});

// 5. 零工时：效率统计显示暂无数据
await step('零工时：效率统计显示暂无数据', async () => {
  await goNav('投递跟踪');
  await page.getByText('记录每次行动与反馈').first().waitFor({ state: 'visible', timeout: 20000 });
  const stats = await page.locator('div.stats').first().innerText();
  if (!stats.includes('每 10 小时面试数')) throw new Error('缺少效率统计卡片');
  if (!stats.includes('暂无数据')) throw new Error(`零工时应显示暂无数据：${stats.replace(/\n+/g, ' | ')}`);
  return '实际投入 0 小时时效率为暂无数据';
});

// 6. 旧计划被替代：确认新计划后旧计划标记 superseded
await step('旧计划结果：确认新计划后旧计划标记为已被替代', async () => {
  // 上一步刻意清空了意向地点，这里先恢复画像，否则岗位会因硬条件待核实而不进入组合。
  await goNav('画像与证据');
  const profileForm = page.locator('form.form-grid').first();
  await profileForm.getByLabel('期望地点（逗号分隔）').fill('广州');
  await profileForm.getByRole('button', { name: '保存画像' }).click();
  await page.locator('.toast.success, .toast').first().waitFor({ state: 'visible', timeout: 20000 });

  await goNav('匹配与组合');
  await page.getByText('看清条件、差距和准备成本').first().waitFor({ state: 'visible', timeout: 20000 });
  // 画像变化会让旧快照过期，先重新跑一次分析，岗位才会进入执行组合。
  const matchPanel = panel('生成匹配解释');
  await matchPanel.getByLabel('选择岗位').selectOption({ index: 1 });
  await matchPanel.getByRole('button', { name: '开始分析' }).click();
  await matchPanel.locator('section.match-result').waitFor({ state: 'visible', timeout: 60000 });

  const portfolio = panel('求职组合');
  await portfolio.getByLabel('每周准备预算（小时）').fill('8');
  await portfolio.getByRole('button', { name: /生成组合|更新组合/ }).click();
  await portfolio.getByText(/组合预算：/).first().waitFor({ state: 'visible', timeout: 30000 });
  const budget = await portfolio.innerText();
  if (/没有岗位|0 个岗位/.test(budget)) throw new Error(`组合没有可选岗位：${budget.replace(/\n+/g, ' | ').slice(0, 160)}`);

  const confirmPlan = async () => {
    // 计划页在生成后会把按钮置为禁用，先离开再进入以获得干净的页面状态。
    await goNav('工作台');
    await page.getByText(/早上好/).first().waitFor({ state: 'visible', timeout: 20000 });
    await goNav('计划与改写');
    await page.getByText('把组合变成两周行动').first().waitFor({ state: 'visible', timeout: 20000 });
    await panel('生成计划草稿').getByRole('button', { name: '生成两周计划' }).click();
    try {
      await page.getByText('计划状态：待确认草稿').first().waitFor({ state: 'visible', timeout: 60000 });
    } catch (error) {
      const notice = await page.locator('.inline-error, .toast').allInnerTexts();
      throw new Error(`${error instanceof Error ? error.message.split('\n')[0] : error}；页面提示：${notice.join(' | ')}`);
    }
    await panel('两周任务与排期').getByRole('button', { name: '确认计划' }).click();
    await page.getByText(/计划已确认|计划状态：已确认/).first().waitFor({ state: 'visible', timeout: 30000 });
  };

  await confirmPlan();
  await confirmPlan();
  // 重新加载后读取，避免读到确认前的列表快照。
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('link', { name: /^计划与改写/ }).first().click();
  await page.getByText('把组合变成两周行动').first().waitFor({ state: 'visible', timeout: 20000 });
  let superseded = 0;
  for (let attempt = 0; attempt < 20 && superseded === 0; attempt += 1) {
    superseded = (await page.locator('button.plan-select').filter({ hasText: 'superseded' }).count())
      + (await page.getByText('已被新计划替代').count());
    if (superseded === 0) await page.waitForTimeout(500);
  }
  if (superseded === 0) {
    const planList = await panel('计划版本').innerText();
    throw new Error(`确认第二份计划后没有出现 superseded 标记；计划列表：${planList.replace(/\n+/g, ' | ').slice(0, 200)}`);
  }
  return '计划列表出现 superseded，详情标注已被新计划替代';
});

await page.screenshot({ path: `${ARTIFACTS}plan-states.png`, fullPage: false });

const failed = results.filter((result) => !result.ok);
console.log('\n================ 汇总 ================');
console.log(`通过 ${results.length - failed.length}/${results.length}`);
if (failed.length) console.log('失败步骤:', JSON.stringify(failed, null, 2));

await browser.close();
process.exit(failed.length ? 1 : 0);
