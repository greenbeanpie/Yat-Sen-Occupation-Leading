import { describe, expect, it } from "vitest";
import { getMf, loginAs, requestAs, STUDENT } from "./helpers";
import { runGeneratePlan } from "../src/application/processors";
import { cronTick } from "../src/application/reminders";

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

async function confirmedPlanWithTasks() {
  const cookie = await loginAs(STUDENT);
  // 直接在 DB 里放一个已选岗位的组合（匹配流程已在 M3/M4 覆盖）
  const portfolio = await requestAs(cookie, "/portfolios", {
    method: "POST",
    body: JSON.stringify({ timeBudgetHours: 20 }),
    headers: { "Content-Type": "application/json", Origin: "http://yso.test" },
  });
  // 没有匹配快照时组合为空 → 直接造组合与任务：用同步协议建任务 + 手动建计划
  void portfolio;
  const env = await makeEnv();
  const userId = STUDENT;
  const now = new Date().toISOString();
  const planId = crypto.randomUUID();
  const taskId = crypto.randomUUID();
  const portfolioId = crypto.randomUUID();
  // confirm 会重算输入指纹，这里按同样算法预先生成
  const { loadRuleContext, contextFingerprint } = await import("../src/application/freshness");
  const ctx = await loadRuleContext(env, userId);
  const fingerprint = await contextFingerprint(ctx, [portfolioId, 1]);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO portfolios (id, user_id, time_budget_hours, items_json, notes_json, created_at, updated_at) VALUES (?1, ?2, 20, '[]', '{}', ?3, ?3)`).bind(
      portfolioId,
      userId,
      now,
    ),
    env.DB
      .prepare(
        `INSERT INTO plans (id, user_id, portfolio_id, status, operation_id, rule_version, input_fingerprint, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'draft', NULL, 'rules-v1', ?4, ?5, ?5)`,
      )
      .bind(planId, userId, portfolioId, fingerprint, now),
    env.DB
      .prepare(
        `INSERT INTO plan_tasks (id, user_id, plan_id, title, description, estimate_hours, scheduled_date, status, deps_json, created_at, updated_at)
         VALUES (?1, ?2, ?3, '准备面试', '模拟任务', 2, ?4, 'pending', '[]', ?5, ?5)`,
      )
      .bind(taskId, userId, planId, "2026-12-01", now),
  ]);
  return { cookie, env, planId, taskId };
}

describe("提醒与通知", () => {
  it("计划确认后任务提醒排期在到期日 09:00（Asia/Shanghai → UTC 前一天 01:00）", async () => {
    const { cookie, env, planId } = await confirmedPlanWithTasks();
    const confirm = await requestAs(cookie, `/plans/${planId}/confirm`, { method: "POST" });
    expect(confirm.status).toBe(200);

    const reminders = await env.DB
      .prepare(`SELECT * FROM reminders WHERE entity = 'task' AND status = 'pending'`)
      .all<Record<string, unknown>>();
    expect(reminders.results.length).toBeGreaterThan(0);
    const r = reminders.results[0]!;
    // 2026-12-01 09:00 Asia/Shanghai == 2026-12-01T01:00:00Z
    expect(r.fire_at).toBe("2026-12-01T01:00:00.000Z");
    expect(r.dedupe_key).toBe(`task-due:${r.entity_id}:2026-12-01`);
  });

  it("Cron tick：到期提醒转为站内通知；用户关闭后不再打扰", async () => {
    const { cookie, env, planId } = await confirmedPlanWithTasks();
    await requestAs(cookie, `/plans/${planId}/confirm`, { method: "POST" });

    // 把 fire_at 改到过去，模拟到期
    await env.DB.prepare(`UPDATE reminders SET fire_at = '2020-01-01T00:00:00.000Z' WHERE status = 'pending'`).run();
    const result = await cronTick(env);
    expect(result.due).toBeGreaterThan(0);
    expect(result.sentInApp).toBe(result.due);

    // 站内通知可见
    const notifications = await requestAs(cookie, "/notifications");
    const body = await notifications.json<{ items: { kind: string }[]; unreadCount: number }>();
    expect(body.items.some((n) => n.kind === "task_due_9am")).toBe(true);
    expect(body.unreadCount).toBeGreaterThan(0);

    // 用户关闭任务提醒后，未到期提醒不再发送
    await requestAs(cookie, "/notifications/settings", {
      method: "PUT",
      body: JSON.stringify({ notifyTaskDue: false }),
      headers: { "Content-Type": "application/json", Origin: "http://yso.test" },
    });
    await env.DB.prepare(`UPDATE reminders SET status = 'pending', sent_at = NULL, fire_at = '2020-01-01T00:00:00.000Z'`).run();
    const result2 = await cronTick(env);
    expect(result2.sentInApp).toBe(0);
  });

  it("任务完成/改期联动提醒；面试默认提前 1 小时", async () => {
    const { cookie, env, planId, taskId } = await confirmedPlanWithTasks();
    await requestAs(cookie, `/plans/${planId}/confirm`, { method: "POST" });

    const taskRow = await env.DB.prepare(`SELECT version FROM plan_tasks WHERE id = ?1`).bind(taskId).first<{ version: number }>();
    // 任务完成 → 提醒取消
    const done = await requestAs(cookie, `/tasks/${taskId}`, {
      method: "PATCH",
      body: JSON.stringify({ baseVersion: taskRow!.version, status: "in_progress" }),
      headers: { "Content-Type": "application/json", Origin: "http://yso.test" },
    });
    const v2 = (await done.json<{ task: { version: number } }>()).task.version;
    await requestAs(cookie, `/tasks/${taskId}`, {
      method: "PATCH",
      body: JSON.stringify({ baseVersion: v2, status: "done" }),
      headers: { "Content-Type": "application/json", Origin: "http://yso.test" },
    });
    const pending = await env.DB.prepare(`SELECT COUNT(*) AS n FROM reminders WHERE entity = 'task' AND entity_id = ?1 AND status = 'pending'`).bind(taskId).first<{ n: number }>();
    expect(pending?.n).toBe(0);

    // 面试提醒：scheduledAt - 1h
    const app = await requestAs(cookie, "/applications", {
      method: "POST",
      body: JSON.stringify({ jobTitle: "后端开发" }),
      headers: { "Content-Type": "application/json", Origin: "http://yso.test" },
    });
    const appId = (await app.json<{ id: string }>()).id;
    const interview = await requestAs(cookie, `/applications/${appId}/interviews`, {
      method: "POST",
      body: JSON.stringify({ scheduledAt: "2026-11-01T06:00:00.000Z", stage: "一面" }),
      headers: { "Content-Type": "application/json", Origin: "http://yso.test" },
    });
    const interviewBody = await interview.json<{ id: string }>();
    const reminder = await env.DB
      .prepare(`SELECT * FROM reminders WHERE entity = 'interview' AND entity_id = ?1`)
      .bind(interviewBody.id)
      .first<Record<string, unknown>>();
    expect(reminder?.fire_at).toBe("2026-11-01T05:00:00.000Z");
    expect(reminder?.dedupe_key).toBe(`interview-1h:${interviewBody.id}`);

    // 改期 → 旧提醒取消 + 新提醒生成
    const iv = await requestAs(cookie, `/interviews/${interviewBody.id}`, {
      method: "PATCH",
      body: JSON.stringify({ baseVersion: 1, scheduledAt: "2026-11-02T06:00:00.000Z" }),
      headers: { "Content-Type": "application/json", Origin: "http://yso.test" },
    });
    expect(iv.status).toBe(200);
    const reminders = await env.DB
      .prepare(`SELECT * FROM reminders WHERE entity = 'interview' AND entity_id = ?1 ORDER BY created_at`)
      .bind(interviewBody.id)
      .all<Record<string, unknown>>();
    const statuses = reminders.results.map((r) => r.status);
    expect(statuses.filter((s) => s === "cancelled").length).toBe(1);
    expect(statuses.filter((s) => s === "pending").length).toBe(1);
  });

  it("演示身份不注册系统推送；公开状态不返回私钥", async () => {
    const cookie=await loginAs(STUDENT);
    const sub=await requestAs(cookie,'/push-subscriptions',{method:'POST',headers:{'Content-Type':'application/json',Origin:'http://yso.test'},body:JSON.stringify({endpoint:'https://fcm.googleapis.com/send/fixture',keys:{p256dh:'fixture',auth:'fixture'}})});
    expect(sub.status).toBe(403);
    const key=await requestAs(cookie,'/notifications/push/status');
    expect(await key.json()).toEqual({configured:false,publicKey:''});
  });
});
