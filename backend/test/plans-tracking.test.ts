import { describe, expect, it } from "vitest";
import { getMf, loginRealAdmin, loginAs, requestAs, STUDENT } from "./helpers";
import { runGenerateMatch, runGeneratePlan, runRewriteResume, runParseJobRequirements } from "../src/application/processors";

async function makeEnv() {
  const { mf } = await getMf();
  return {
    DB: await mf.getD1Database("DB"),
    DOCS: await mf.getR2Bucket("DOCS"),
    AI_PROVIDER: "mock",
    AI_BASE_URL: "",
    AI_MODEL: "",
  } as unknown as import("../src/env").Env;
}

async function runProcessor(
  fn: (env: import("../src/env").Env, operationId: string) => Promise<{ status: string; error?: string }>,
  operationId: string,
) {
  return fn(await makeEnv(), operationId);
}

/** 准备：管理员发布岗位 → 学生建画像 → 匹配 → 组合（含已选岗位）。 */
async function setupPortfolio(): Promise<{ cookie: string; portfolioId: string; jobId: string }> {
  const adminCookie = await loginRealAdmin();
  const create = await requestAs(adminCookie, "/admin/jobs", {
    method: "POST",
    body: JSON.stringify({
      title: "后端开发工程师",
      company: "示例科技",
      location: "上海",
      jdText: "我们寻找熟悉 TypeScript 的后端工程师。要求掌握 TypeScript 与 Node.js。工作地点上海。",
    }),
    headers: { "Content-Type": "application/json" },
  });
  const job = await create.json<{ id: string }>();
  const parse = await requestAs(adminCookie, `/jobs/${job.id}/parse-requirements`, { method: "POST" });
  const { operationId: parseOp } = await parse.json<{ operationId: string }>();
  await runProcessor(runParseJobRequirements, parseOp);
  await requestAs(adminCookie, `/jobs/${job.id}/requirements/confirm`, { method: "POST" });
  await requestAs(adminCookie, `/admin/jobs/${job.id}/publish`, {
    method: "POST",
    body: JSON.stringify({ action: "publish" }),
    headers: { "Content-Type": "application/json" },
  });

  const cookie = await loginAs(STUDENT);
  await requestAs(cookie, "/profile", {
    method: "PUT",
    body: JSON.stringify({ targetRoles: ["后端开发"], degree: "bachelor", graduationYear: 2026, preferredLocations: ["上海"] }),
    headers: { "Content-Type": "application/json" },
  });
  const exp = await requestAs(cookie, "/evidence/experiences", {
    method: "POST",
    body: JSON.stringify({ title: "项目经历", description: "使用 TypeScript 与 Node.js 开发过课程管理系统。" }),
    headers: { "Content-Type": "application/json" },
  });
  const expBody = await exp.json<{ id: string }>();
  // 为 JD 中的技能建立已确认证据，硬条件才能全部满足
  for (const name of ["TypeScript", "Node.js"]) {
    const skill = await requestAs(cookie, "/evidence/skills", {
      method: "POST",
      body: JSON.stringify({ name }),
      headers: { "Content-Type": "application/json" },
    });
    const skillBody = await skill.json<{ id: string }>();
    const link = await requestAs(cookie, "/evidence/links", {
      method: "POST",
      body: JSON.stringify({ skillId: skillBody.id, experienceId: expBody.id, quote: "使用 TypeScript 与 Node.js 开发过课程管理系统" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(link.status).toBe(201);
    const linkBody = await link.json<{ id: string }>();
    await requestAs(cookie, `/evidence/links/${linkBody.id}`, {
      method: "PUT",
      body: JSON.stringify({ status: "confirmed" }),
      headers: { "Content-Type": "application/json" },
    });
  }

  const match = await requestAs(cookie, "/matches", {
    method: "POST",
    body: JSON.stringify({ jobId: job.id }),
    headers: { "Content-Type": "application/json" },
  });
  const { operationId } = await match.json<{ operationId: string }>();
  const result = await runProcessor(runGenerateMatch, operationId);
  expect(result.status).toBe("succeeded");

  const portfolio = await requestAs(cookie, "/portfolios", {
    method: "POST",
    body: JSON.stringify({ timeBudgetHours: 20 }),
    headers: { "Content-Type": "application/json" },
  });
  expect(portfolio.status).toBe(201);
  const portfolioBody = await portfolio.json<{ id: string; items: { jobId: string; selected: boolean }[] }>();
  expect(portfolioBody.items.some((i) => i.jobId === job.id && i.selected)).toBe(true);
  return { cookie, portfolioId: portfolioBody.id, jobId: job.id };
}

describe("计划与任务", () => {
  it("生成草稿 → 确认采纳 → 任务更新（done + 实际工时保留）", async () => {
    const { cookie, portfolioId, jobId } = await setupPortfolio();

    const create = await requestAs(cookie, "/plans", {
      method: "POST",
      body: JSON.stringify({ portfolioId }),
      headers: { "Content-Type": "application/json" },
    });
    expect(create.status).toBe(202);
    const { operationId } = await create.json<{ operationId: string }>();
    const result = await runProcessor(runGeneratePlan, operationId);
    expect(result.status).toBe("succeeded");

    const list = await requestAs(cookie, "/plans");
    const listBody = await list.json<{ items: { id: string; status: string }[] }>();
    const plan = listBody.items[0]!;
    expect(plan.status).toBe("draft");

    const detail = await requestAs(cookie, `/plans/${plan.id}`);
    const detailBody = await detail.json<{
      tasks: {
        id: string;
        version: number;
        scheduledDate: string | null;
        estimateHours: number | null;
        jobId: string | null;
        evidenceId: string | null;
        gap: string | null;
        deps: string[];
      }[];
    }>();
    expect(detailBody.tasks.length).toBeGreaterThan(0);

    // PLAN.md 2.5：任务必须关联具体岗位与已确认证据，并带依赖关系
    const tasks = detailBody.tasks;
    expect(tasks.every((task) => task.jobId === jobId)).toBe(true);
    expect(tasks.some((task) => task.evidenceId !== null)).toBe(true);
    expect(tasks[0]!.deps).toEqual([]);
    expect(tasks[1]!.deps).toEqual([tasks[0]!.id]);
    const indexOf = (id: string) => tasks.findIndex((task) => task.id === id);
    expect(tasks.every((task, index) => task.deps.every((dep) => indexOf(dep) < index))).toBe(true);

    // 确认采纳
    const confirm = await requestAs(cookie, `/plans/${plan.id}/confirm`, { method: "POST" });
    expect(confirm.status).toBe(200);
    const confirmBody = await confirm.json<{ status: string }>();
    expect(confirmBody.status).toBe("confirmed");

    // 任务完成：记录实际工时
    const task = detailBody.tasks[0]!;
    const update = await requestAs(cookie, `/tasks/${task.id}`, {
      method: "PATCH",
      body: JSON.stringify({ baseVersion: task.version, status: "in_progress" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(update.status).toBe(200);
    const updatedTask = await update.json<{ task: { version: number } }>();

    const done = await requestAs(cookie, `/tasks/${task.id}`, {
      method: "PATCH",
      body: JSON.stringify({ baseVersion: updatedTask.task.version, status: "done", actualHours: 2.5 }),
      headers: { "Content-Type": "application/json" },
    });
    expect(done.status).toBe(200);

    // 已完成任务不被消失
    const after = await requestAs(cookie, `/plans/${plan.id}`);
    const afterBody = await after.json<{ tasks: { id: string; status: string; actualHours: number | null }[] }>();
    const doneTask = afterBody.tasks.find((t) => t.id === task.id)!;
    expect(doneTask.status).toBe("done");
    expect(doneTask.actualHours).toBe(2.5);
  });

  it("确认新计划后旧计划被标记 superseded，旧任务与实际工时保留", async () => {
    const { cookie, portfolioId } = await setupPortfolio();

    const createPlan = async (): Promise<string> => {
      const created = await requestAs(cookie, "/plans", {
        method: "POST",
        body: JSON.stringify({ portfolioId }),
        headers: { "Content-Type": "application/json" },
      });
      const { operationId } = await created.json<{ operationId: string }>();
      await runProcessor(runGeneratePlan, operationId);
      const operation = await requestAs(cookie, `/operations/${operationId}`);
      const { resultRef } = await operation.json<{ resultRef: string }>();
      return resultRef;
    };

    const firstPlanId = await createPlan();
    const firstConfirm = await requestAs(cookie, `/plans/${firstPlanId}/confirm`, { method: "POST" });
    expect(firstConfirm.status).toBe(200);

    const secondPlanId = await createPlan();
    const secondConfirm = await requestAs(cookie, `/plans/${secondPlanId}/confirm`, { method: "POST" });
    expect(secondConfirm.status).toBe(200);

    const list = await requestAs(cookie, "/plans");
    const items = (await list.json<{ items: { id: string; status: string }[] }>()).items;
    expect(items.find((plan) => plan.id === secondPlanId)?.status).toBe("confirmed");
    expect(items.find((plan) => plan.id === firstPlanId)?.status).toBe("superseded");

    // 旧计划的任务不因重新规划消失
    const firstDetail = await requestAs(cookie, `/plans/${firstPlanId}`);
    expect((await firstDetail.json<{ tasks: unknown[] }>()).tasks.length).toBeGreaterThan(0);

    // 已被替代的计划不能再确认
    const again = await requestAs(cookie, `/plans/${firstPlanId}/confirm`, { method: "POST" });
    expect(again.status).toBe(422);
  });

  it("任务延期产生调整建议（不自动覆盖），采纳才生效", async () => {
    const { cookie, portfolioId } = await setupPortfolio();
    const create = await requestAs(cookie, "/plans", {
      method: "POST",
      body: JSON.stringify({ portfolioId }),
      headers: { "Content-Type": "application/json" },
    });
    const { operationId } = await create.json<{ operationId: string }>();
    await runProcessor(runGeneratePlan, operationId);
    const list = await requestAs(cookie, "/plans");
    const plan = (await list.json<{ items: { id: string }[] }>()).items[0]!;
    const detail = await requestAs(cookie, `/plans/${plan.id}`);
    const task = (await detail.json<{ tasks: { id: string; version: number; scheduledDate: string | null }[] }>().then((b) => b.tasks[0]))!;

    await requestAs(cookie, `/plans/${plan.id}/confirm`, { method: "POST" }).then((r) => {
      expect(r.status).toBe(200);
    });

    // 延期任务
    const newDate = "2026-12-31";
    const update = await requestAs(cookie, `/tasks/${task.id}`, {
      method: "PATCH",
      body: JSON.stringify({ baseVersion: task.version, scheduledDate: newDate }),
      headers: { "Content-Type": "application/json" },
    });
    expect(update.status).toBe(200);
    expect(update.status).toBe(200);
    const { suggestionId } = await update.json<{ suggestionId: string | null }>();
    expect(suggestionId).toBeTruthy();

    // 建议列表可见，状态 pending
    const suggestions = await requestAs(cookie, `/plans/${plan.id}/suggestions`);
    const suggestionsBody = await suggestions.json<{ items: { id: string; trigger: string; status: string }[] }>();
    expect(suggestionsBody.items.some((s) => s.trigger === "task_delay" && s.status === "pending")).toBe(true);

    // 采纳建议（应用变更）
    const resolve = await requestAs(cookie, `/suggestions/${suggestionId}/resolve`, {
      method: "POST",
      body: JSON.stringify({ action: "accept" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(resolve.status).toBe(200);
    const resolveBody = await resolve.json<{ status: string }>();
    expect(resolveBody.status).toBe("accepted");
  });
});

describe("简历改写", () => {
  it("创建改写 → 引用核验 → 逐条采纳应用到经历（原文变化）", async () => {
    const cookie = await loginAs(STUDENT);
    const expRes = await requestAs(cookie, "/evidence/experiences", {
      method: "POST",
      body: JSON.stringify({ title: "课程项目", description: "负责后端接口开发，使用 TypeScript 完成服务端模块。" }),
      headers: { "Content-Type": "application/json" },
    });
    const exp = await expRes.json<{ id: string; version: number }>();

    const create = await requestAs(cookie, "/rewrites", {
      method: "POST",
      body: JSON.stringify({ experienceId: exp.id }),
      headers: { "Content-Type": "application/json" },
    });
    expect(create.status).toBe(202);
    const { operationId } = await create.json<{ operationId: string }>();
    const result = await runProcessor(runRewriteResume, operationId);
    expect(result.status).toBe("succeeded");

    const rewriteRes = await requestAs(cookie, `/operations/${operationId}`);
    const { resultRef } = await rewriteRes.json<{ resultRef: string }>();
    const rewrite = await requestAs(cookie, `/rewrites/${resultRef}`);
    const rewriteBody = await rewrite.json<{ items: { id: string; originalQuote: string; status: string }[] }>();
    expect(rewriteBody.items.length).toBeGreaterThan(0);
    const item = rewriteBody.items[0]!;
    expect(item.status).toBe("pending");

    // 采纳后经历描述应用建议文本，版本 +1
    const resolve = await requestAs(cookie, `/rewrites/${resultRef}/items/${item.id}/resolve`, {
      method: "POST",
      body: JSON.stringify({ action: "accept" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(resolve.status).toBe(200);

    const bundle = await requestAs(cookie, "/evidence");
    const bundleBody = await bundle.json<{ experiences: { id: string; version: number; description: string }[] }>();
    const updated = bundleBody.experiences.find((e) => e.id === exp.id)!;
    expect(updated.version).toBe(exp.version + 1);
    expect(updated.description).toContain("表述更聚焦岗位职责与产出");
  });
});

describe("投递跟踪与效率统计", () => {
  it("状态机校验：preparing → interviewing 非法；历史事件保留", async () => {
    const cookie = await loginAs(STUDENT);
    const create = await requestAs(cookie, "/applications", {
      method: "POST",
      body: JSON.stringify({ jobTitle: "后端开发", company: "示例科技" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(create.status).toBe(201);
    const app = await create.json<{ id: string; version: number; status: string }>();
    expect(app.status).toBe("preparing");

    // 非法流转
    const bad = await requestAs(cookie, `/applications/${app.id}`, {
      method: "PATCH",
      body: JSON.stringify({ baseVersion: app.version, status: "interviewing" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(bad.status).toBe(422);

    // 合法流转：preparing → submitted → interviewing
    const s1 = await requestAs(cookie, `/applications/${app.id}`, {
      method: "PATCH",
      body: JSON.stringify({ baseVersion: app.version, status: "submitted" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(s1.status).toBe(200);
    const afterS1 = await s1.json<{ version: number }>();
    const s2 = await requestAs(cookie, `/applications/${app.id}/events`, {
      method: "POST",
      body: JSON.stringify({ type: "status_change", toStatus: "interviewing", note: "收到面试邀请" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(s2.status).toBe(201);

    const events = await requestAs(cookie, `/applications/${app.id}/events`);
    const eventsBody = await events.json<{ items: { toStatus: string | null; note: string | null }[] }>();
    expect(eventsBody.items.some((e) => e.toStatus === "submitted")).toBe(true);
    expect(eventsBody.items.some((e) => e.toStatus === "interviewing" && e.note === "收到面试邀请")).toBe(true);
    void afterS1;
  });

  it("面试安排 + 工时录入 + 效率统计（含零工时→null）", async () => {
    // Workerd timestamps status events with its real clock. Keep the query and
    // time-entry fixture in the same UTC window instead of hardcoding Sep 2026.
    // One-day padding avoids midnight races between the test and Worker clocks.
    const anchor = Date.now();
    const spentOn = new Date(anchor).toISOString().slice(0, 10);
    const from = new Date(anchor - 86_400_000).toISOString().slice(0, 10);
    const to = new Date(anchor + 86_400_000).toISOString().slice(0, 10);
    const statsUrl = `/applications/stats?from=${from}&to=${to}`;
    const cookie = await loginAs(STUDENT);
    const create = await requestAs(cookie, "/applications", {
      method: "POST",
      body: JSON.stringify({ jobTitle: "后端开发" }),
      headers: { "Content-Type": "application/json" },
    });
    const app = await create.json<{ id: string }>();

    // 零工时 → efficiency null
    const stats0 = await requestAs(cookie, statsUrl);
    const stats0Body = await stats0.json<{ efficiency: number | null; interviewedCount: number }>();
    expect(stats0Body.efficiency).toBeNull();

    // 面试安排
    const interview = await requestAs(cookie, `/applications/${app.id}/interviews`, {
      method: "POST",
      body: JSON.stringify({ scheduledAt: "2026-10-10T02:00:00.000Z", stage: "一面" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(interview.status).toBe(201);

    // 工时
    const entry = await requestAs(cookie, "/time-entries", {
      method: "POST",
      body: JSON.stringify({ applicationId: app.id, minutes: 120, spentOn }),
      headers: { "Content-Type": "application/json" },
    });
    expect(entry.status).toBe(201);

    // 进入面试状态（去重计数）
    const detail = await requestAs(cookie, `/applications/${app.id}`);
    const detailBody = await detail.json<{ version: number }>();
    await requestAs(cookie, `/applications/${app.id}`, {
      method: "PATCH",
      body: JSON.stringify({ baseVersion: detailBody.version, status: "submitted" }),
      headers: { "Content-Type": "application/json" },
    });
    const afterSubmit = await requestAs(cookie, `/applications/${app.id}`);
    const v = (await afterSubmit.json<{ version: number }>()).version;
    await requestAs(cookie, `/applications/${app.id}/events`, {
      method: "POST",
      body: JSON.stringify({ type: "status_change", toStatus: "interviewing" }),
      headers: { "Content-Type": "application/json" },
    });
    void v;

    const stats = await requestAs(cookie, statsUrl);
    const statsBody = await stats.json<{ interviewedCount: number; totalHours: number; efficiency: number | null }>();
    expect(statsBody.interviewedCount).toBe(1);
    expect(statsBody.totalHours).toBeCloseTo(2, 5);
    // 1 / 2 * 10 = 5
    expect(statsBody.efficiency).toBeCloseTo(5, 5);
  });
});
