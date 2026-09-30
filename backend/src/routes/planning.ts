import { pageRows } from "../infra/pagination";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  AcceptedResponseSchema,
  AdjustmentSuggestionSchema,
  CreatePlanSchema,
  CreateRewriteSchema,
  ErrorBodySchema,
  PlanDetailSchema,
  PlanSchema,
  RewriteSchema,
  TaskUpdateSchema,
  UuidSchema,
} from "../shared/schemas";
import { requireAuth } from "../middleware/auth";
import { conflict, invalidRequest, notFound } from "../shared/errors";
import { startOperation } from "../application/operations";
import { assertFreshInputs, contextParts, loadRuleContext } from "../application/freshness";
import { EXPERIENCE_CFG, TASK_CFG } from "../application/configs";
import { rowToJson, updateEntity } from "../application/entity-writer";
import { canTransitionTask } from "../domain/state";
import { changeLogStmt } from "../infra/db/helpers";
import { nowIso, uuid } from "../shared/datetime";
import { cancelRemindersFor, scheduleTaskReminder } from "../application/reminders";
import type { AppEnv } from "../env";

type App = OpenAPIHono<AppEnv>;

const idParam = { name: "id", in: "params" as const, required: true, schema: UuidSchema };

const createPlan = createRoute({
  method: "post",
  path: "/plans",
  tags: ["plans"],
  middleware: [requireAuth] as const,
  request: { body: { content: { "application/json": { schema: CreatePlanSchema } }, required: true } },
  responses: {
    202: { content: { "application/json": { schema: AcceptedResponseSchema } }, description: "计划生成作业已排队" },
    409: { content: { "application/json": { schema: ErrorBodySchema } }, description: "sync_required：存在未同步修改" },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
  },
});

const listPlans = createRoute({
  method: "get",
  path: "/plans",
  tags: ["plans"],
  middleware: [requireAuth] as const,
  responses: {
    200: { content: { "application/json": { schema: z.object({ items: z.array(PlanSchema), nextCursor: z.string().nullable().optional() }) } }, description: "我的计划列表" },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
  },
});

const getPlan = createRoute({
  method: "get",
  path: "/plans/{id}",
  tags: ["plans"],
  middleware: [requireAuth] as const,
  request: { params: z.object({ id: UuidSchema }) },
  responses: {
    200: { content: { "application/json": { schema: PlanDetailSchema } }, description: "计划详情（含任务）" },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
    404: { content: { "application/json": { schema: ErrorBodySchema } }, description: "不存在" },
  },
});

const confirmPlan = createRoute({
  method: "post",
  path: "/plans/{id}/confirm",
  tags: ["plans"],
  middleware: [requireAuth] as const,
  request: { params: z.object({ id: UuidSchema }) },
  responses: {
    200: { content: { "application/json": { schema: PlanSchema } }, description: "计划已采纳（学生确认后生效）" },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
    409: { content: { "application/json": { schema: ErrorBodySchema } }, description: "版本冲突" },
  },
});

const updateTask = createRoute({
  method: "patch",
  path: "/tasks/{id}",
  tags: ["tasks"],
  middleware: [requireAuth] as const,
  request: {
    params: z.object({ id: UuidSchema }),
    body: { content: { "application/json": { schema: TaskUpdateSchema.extend({ baseVersion: z.number().int() }) } }, required: true },
  },
  responses: {
    200: { content: { "application/json": { schema: z.object({ task: z.unknown(), suggestionId: UuidSchema.nullish() }) } }, description: "已更新（必要时产生调整建议）" },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
    409: { content: { "application/json": { schema: ErrorBodySchema } }, description: "版本冲突" },
  },
});

const listSuggestions = createRoute({
  method: "get",
  path: "/plans/{id}/suggestions",
  tags: ["plans"],
  middleware: [requireAuth] as const,
  request: { params: z.object({ id: UuidSchema }) },
  responses: {
    200: { content: { "application/json": { schema: z.object({ items: z.array(AdjustmentSuggestionSchema), nextCursor: z.string().nullable().optional() }) } }, description: "调整建议列表" },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
  },
});

const resolveSuggestion = createRoute({
  method: "post",
  path: "/suggestions/{id}/resolve",
  tags: ["plans"],
  middleware: [requireAuth] as const,
  request: {
    params: z.object({ id: UuidSchema }),
    body: { content: { "application/json": { schema: z.object({ action: z.enum(["accept", "reject"]) }) } }, required: true },
  },
  responses: {
    200: { content: { "application/json": { schema: AdjustmentSuggestionSchema } }, description: "建议已采纳（应用变更）或驳回" },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
    409: { content: { "application/json": { schema: ErrorBodySchema } }, description: "版本冲突" },
  },
});

const createRewrite = createRoute({
  method: "post",
  path: "/rewrites",
  tags: ["rewrites"],
  middleware: [requireAuth] as const,
  request: { body: { content: { "application/json": { schema: CreateRewriteSchema } }, required: true } },
  responses: {
    202: { content: { "application/json": { schema: AcceptedResponseSchema } }, description: "改写作业已排队" },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
  },
});

const getRewrite = createRoute({
  method: "get",
  path: "/rewrites/{id}",
  tags: ["rewrites"],
  middleware: [requireAuth] as const,
  request: { params: z.object({ id: UuidSchema }) },
  responses: {
    200: { content: { "application/json": { schema: RewriteSchema } }, description: "改写建议（原文对照，逐条采纳）" },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
    404: { content: { "application/json": { schema: ErrorBodySchema } }, description: "不存在" },
  },
});

const resolveRewriteItem = createRoute({
  method: "post",
  path: "/rewrites/{id}/items/{itemId}/resolve",
  tags: ["rewrites"],
  middleware: [requireAuth] as const,
  request: {
    params: z.object({ id: UuidSchema, itemId: z.string() }),
    body: { content: { "application/json": { schema: z.object({ action: z.enum(["accept", "reject"]) }) } }, required: true },
  },
  responses: {
    200: { content: { "application/json": { schema: RewriteSchema } }, description: "采纳后改写文本应用到经历（版本 +1）" },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
    409: { content: { "application/json": { schema: ErrorBodySchema } }, description: "版本冲突" },
  },
});

export function registerPlanningRoutes(app: App): void {
  app.openapi(createPlan, async (c) => {
    const userId = c.get("user").id;
    const body = c.req.valid("json");
    await assertFreshInputs(c.env, userId, body.clientProfileVersion, body.clientExperienceVersions);
    const portfolio = await c.env.DB.prepare(`SELECT id, version FROM portfolios WHERE id = ?1 AND user_id = ?2 AND deleted = 0`)
      .bind(body.portfolioId, userId)
      .first<{ version: number }>();
    if (!portfolio) throw notFound("组合不存在");
    const ctx = await loadRuleContext(c.env, userId);
    const operationId = await startOperation(c.env, userId, "generate_plan", { portfolioId: body.portfolioId }, contextParts(ctx, [body.portfolioId, portfolio.version]));
    return c.json({ operationId }, 202 as const) as never;
  });

  app.openapi(listPlans, async (c) => {
    const userId = c.get("user").id;
    const rows = await pageRows(c, `SELECT * FROM plans WHERE user_id = ?1 AND deleted = 0 ORDER BY created_at DESC, id DESC`, [userId]);
    return c.json({ items: rows.results.map(planToJson), nextCursor: rows.nextCursor }, 200 as const) as never;
  });

  app.openapi(getPlan, async (c) => {
    const userId = c.get("user").id;
    const { id } = c.req.valid("param");
    const plan = await c.env.DB.prepare(`SELECT * FROM plans WHERE id = ?1 AND user_id = ?2 AND deleted = 0`).bind(id, userId).first<Record<string, unknown>>();
    if (!plan) throw notFound();
    const tasks = await c.env.DB.prepare(`SELECT * FROM plan_tasks WHERE plan_id = ?1 AND user_id = ?2 AND deleted = 0 ORDER BY scheduled_date, created_at`).bind(id, userId).all<Record<string, unknown>>();
    return c.json({ plan: planToJson(plan), tasks: tasks.results.map((t) => rowToJson(TASK_CFG, t)) } as never, 200 as const);
  });

  app.openapi(confirmPlan, async (c) => {
    const userId = c.get("user").id;
    const { id } = c.req.valid("param");
    const plan = await c.env.DB.prepare(`SELECT * FROM plans WHERE id = ?1 AND user_id = ?2 AND deleted = 0`).bind(id, userId).first<Record<string, unknown>>();
    if (!plan) throw notFound();
    if (plan.status !== "draft") throw invalidRequest([{ field: "id", issue: "计划不是草稿状态" }]);
    // 采纳时再次检查版本：画像/经历若在生成后变化过，则要求重新生成（PLAN.md 2.5）
    const ctx = await loadRuleContext(c.env, userId);
    const { fingerprintOf } = await import("../infra/db/helpers");
    const currentFingerprint = await fingerprintOf(contextParts(ctx, [portfolioRef(plan), plan.version]));
    if (currentFingerprint !== plan.input_fingerprint) {
      throw conflict("计划生成后画像或经历已变化，请重新生成", planToJson(plan));
    }
    const now = nowIso();
    // 确认新计划时，同一学生的其他已确认计划标记为 superseded：
    // 旧计划的任务与实际工时不删除，只是不再生效（PLAN.md 2.5）。
    const previous = await c.env.DB
      .prepare(`SELECT id FROM plans WHERE user_id = ?1 AND id <> ?2 AND status = 'confirmed' AND deleted = 0`)
      .bind(userId, id)
      .all<{ id: string }>();
    await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE plans SET status = 'confirmed', version = version + 1, updated_at = ?1 WHERE id = ?2`).bind(now, id),
      ...previous.results.map((row) =>
        c.env.DB
          .prepare(`UPDATE plans SET status = 'superseded', version = version + 1, updated_at = ?1 WHERE id = ?2`)
          .bind(now, row.id),
      ),
    ]);

    // 变更日志：让增量同步的客户端也能看到计划被替代或被确认。
    const changedIds = [id, ...previous.results.map((row) => row.id)];
    const changed = await c.env.DB
      .prepare(
        `SELECT * FROM plans WHERE user_id = ?1 AND id IN (${changedIds.map((_, index) => `?${index + 2}`).join(", ")})`,
      )
      .bind(userId, ...changedIds)
      .all<Record<string, unknown>>();
    if (changed.results.length > 0) {
      await c.env.DB.batch(
        changed.results.map((row) =>
          changeLogStmt(
            c.env.DB,
            {
              userId,
              entity: "plan",
              entityId: row.id as string,
              version: Number(row.version),
              changeType: "upsert",
              record: planToJson(row),
            },
            now,
          ),
        ),
      );
    }
    // 确认后为每个任务排到期提醒（到期日 09:00，用户时区）
    const user = c.get("user");
    const tasks = await c.env.DB
      .prepare(`SELECT id, version, title, scheduled_date FROM plan_tasks WHERE plan_id = ?1 AND user_id = ?2 AND deleted = 0 AND status IN ('pending','in_progress')`)
      .bind(id, userId)
      .all<{ id: string; version: number; title: string; scheduled_date: string | null }>();
    for (const t of tasks.results) {
      await scheduleTaskReminder(c.env, userId, t.id, t.version, t.title, t.scheduled_date ?? "", user.timezone);
    }
    const updated = await c.env.DB.prepare(`SELECT * FROM plans WHERE id = ?1`).bind(id).first<Record<string, unknown>>();
    return c.json(planToJson(updated!) as never, 200 as const);
  });

  app.openapi(updateTask, async (c) => {
    const userId = c.get("user").id;
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const { baseVersion, ...payload } = body as Record<string, unknown> & { baseVersion: number };
    const task = await c.env.DB.prepare(`SELECT * FROM plan_tasks WHERE id = ?1 AND user_id = ?2 AND deleted = 0`).bind(id, userId).first<Record<string, unknown>>();
    if (!task) throw notFound();
    const plan = await c.env.DB.prepare(`SELECT * FROM plans WHERE id = ?1`).bind(task.plan_id as string).first<Record<string, unknown>>();
    if (!plan) throw notFound();

    if (payload.status && !canTransitionTask(task.status as string, payload.status as string)) {
      throw invalidRequest([{ field: "status", issue: `任务不能从 ${task.status} 变为 ${payload.status}` }]);
    }

    // 已完成任务与实际工时保留（不因重新规划消失）——done 为终态
    const suggestionId = await maybeCreateAdjustment(c.env, userId, plan as Record<string, unknown>, task as Record<string, unknown>, payload, baseVersion);

    const { record } = await updateEntity(c.env, userId, TASK_CFG, id, baseVersion, payload);

    // 提醒联动：改期重排、完成/取消撤销（提醒绑定任务版本）
    if (plan.status === "confirmed") {
      const user = c.get("user");
      const newStatus = payload.status as string | undefined;
      if (newStatus === "done" || newStatus === "cancelled") {
        await cancelRemindersFor(c.env, userId, "task", id);
      } else if (payload.scheduledDate !== undefined) {
        await scheduleTaskReminder(c.env, userId, id, Number(record.version), record.title as string, (record.scheduledDate as string | null) ?? "", user.timezone);
      }
    }
    return c.json({ task: record, suggestionId: suggestionId ?? null } as never, 200 as const);
  });

  app.openapi(listSuggestions, async (c) => {
    const userId = c.get("user").id;
    const { id } = c.req.valid("param");
    const rows = await pageRows(c, `SELECT * FROM adjustment_suggestions WHERE plan_id = ?1 AND user_id = ?2 AND deleted = 0 ORDER BY created_at DESC, id DESC`, [id, userId]);
    return c.json({ items: rows.results.map(suggestionToJson), nextCursor: rows.nextCursor }, 200 as const) as never;
  });

  app.openapi(resolveSuggestion, async (c) => {
    const userId = c.get("user").id;
    const { id } = c.req.valid("param");
    const { action } = c.req.valid("json");
    const sug = await c.env.DB
      .prepare(`SELECT * FROM adjustment_suggestions WHERE id = ?1 AND user_id = ?2 AND deleted = 0`)
      .bind(id, userId)
      .first<Record<string, unknown>>();
    if (!sug) throw notFound();
    if (sug.status !== "pending") throw invalidRequest([{ field: "id", issue: "建议已处理" }]);

    if (action === "accept") {
      // 应用提案（带版本检查，冲突即 409）
      const proposal = JSON.parse((sug.proposal_json as string) ?? "{}") as {
        taskId?: string;
        taskBaseVersion?: number;
        setScheduledDate?: string | null;
        setEstimateHours?: number | null;
      };
      if (proposal.taskId) {
        const payload: Record<string, unknown> = {};
        if (proposal.setScheduledDate !== undefined) payload.scheduledDate = proposal.setScheduledDate;
        if (proposal.setEstimateHours !== undefined) payload.estimateHours = proposal.setEstimateHours;
        await updateEntity(c.env, userId, TASK_CFG, proposal.taskId, proposal.taskBaseVersion ?? null, payload);
      }
    }
    await c.env.DB
      .prepare(`UPDATE adjustment_suggestions SET status = ?2, updated_at = ?3 WHERE id = ?1`)
      .bind(id, action === "accept" ? "accepted" : "rejected", nowIso())
      .run();
    const updated = await c.env.DB.prepare(`SELECT * FROM adjustment_suggestions WHERE id = ?1`).bind(id).first<Record<string, unknown>>();
    return c.json(suggestionToJson(updated!) as never, 200 as const);
  });

  app.openapi(createRewrite, async (c) => {
    const userId = c.get("user").id;
    const body = c.req.valid("json");
    const experience = await c.env.DB.prepare(`SELECT id FROM experiences WHERE id = ?1 AND user_id = ?2 AND deleted = 0`).bind(body.experienceId, userId).first();
    if (!experience) throw notFound("经历不存在");
    const ctx = await loadRuleContext(c.env, userId);
    const expRow = await c.env.DB.prepare(`SELECT version FROM experiences WHERE id = ?1`).bind(body.experienceId).first<{ version: number }>();
    const operationId = await startOperation(c.env, userId, "rewrite_resume", { experienceId: body.experienceId }, contextParts(ctx, [body.experienceId, expRow?.version ?? 0]));
    return c.json({ operationId }, 202 as const) as never;
  });

  app.openapi(getRewrite, async (c) => {
    const userId = c.get("user").id;
    const { id } = c.req.valid("param");
    const row = await c.env.DB.prepare(`SELECT * FROM rewrites WHERE id = ?1 AND user_id = ?2 AND deleted = 0`).bind(id, userId).first<Record<string, unknown>>();
    if (!row) throw notFound();
    return c.json(rewriteToJson(row) as never, 200 as const);
  });

  app.openapi(resolveRewriteItem, async (c) => {
    const userId = c.get("user").id;
    const { id, itemId } = c.req.valid("param");
    const { action } = c.req.valid("json");
    const row = await c.env.DB.prepare(`SELECT * FROM rewrites WHERE id = ?1 AND user_id = ?2 AND deleted = 0`).bind(id, userId).first<Record<string, unknown>>();
    if (!row) throw notFound();
    const data = JSON.parse((row.items_json as string) ?? "{}") as {
      items: { id: string; originalQuote: string; suggestion: string; rationale: string; quoteVerified: boolean; status: string }[];
    };
    const item = data.items.find((i) => i.id === itemId);
    if (!item) throw notFound("改写条目不存在");
    if (item.status !== "pending") throw invalidRequest([{ field: "itemId", issue: "条目已处理" }]);
    item.status = action === "accept" ? "accepted" : "rejected";

    const stmts: D1PreparedStatement[] = [
      c.env.DB.prepare(`UPDATE rewrites SET items_json = ?2, updated_at = ?3 WHERE id = ?1`).bind(id, JSON.stringify(data), nowIso()),
    ];

    if (action === "accept") {
      // 采纳：把经历原文中的引用句替换为建议文本（不新增事实），经历版本 +1
      const experience = await c.env.DB.prepare(`SELECT * FROM experiences WHERE id = ?1 AND user_id = ?2 AND deleted = 0`)
        .bind(row.experience_id as string, userId)
        .first<Record<string, unknown>>();
      if (!experience) throw notFound("经历不存在");
      const description = experience.description as string;
      if (!description.includes(item.originalQuote)) {
        throw conflict("经历原文已变化，无法安全应用改写", rowToJson(EXPERIENCE_CFG, experience));
      }
      const newDescription = description.replace(item.originalQuote, item.suggestion);
      await updateEntity(c.env, userId, EXPERIENCE_CFG, experience.id as string, Number(experience.version), {
        title: experience.title,
        organization: experience.organization,
        kind: experience.kind,
        description: newDescription,
      } as Record<string, unknown>);
    }
    await c.env.DB.batch(stmts);
    const updated = await c.env.DB.prepare(`SELECT * FROM rewrites WHERE id = ?1`).bind(id).first<Record<string, unknown>>();
    return c.json(rewriteToJson(updated!) as never, 200 as const);
  });
}

function portfolioRef(plan: Record<string, unknown>): string {
  return (plan.portfolio_id as string) ?? "";
}

function planToJson(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    userId: row.user_id,
    version: Number(row.version),
    deleted: Number(row.deleted) === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    portfolioId: row.portfolio_id ?? null,
    status: row.status,
    ruleVersion: row.rule_version,
  };
}

function suggestionToJson(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    userId: row.user_id,
    version: Number(row.version),
    deleted: Number(row.deleted) === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    planId: row.plan_id,
    trigger: row.trigger,
    summary: row.summary,
    proposal: JSON.parse((row.proposal_json as string) ?? "{}"),
    status: row.status,
  };
}

function rewriteToJson(row: Record<string, unknown>): Record<string, unknown> {
  const data = JSON.parse((row.items_json as string) ?? "{}") as { items: unknown[] };
  return {
    id: row.id,
    userId: row.user_id,
    version: Number(row.version),
    deleted: Number(row.deleted) === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    experienceId: row.experience_id,
    operationId: row.operation_id ?? null,
    items: data.items ?? [],
    status: row.status,
    error: row.error ?? null,
  };
}

/** 任务更新触发调整建议（PLAN.md 2.5：延期/超时只产生建议，不自动覆盖）。 */
async function maybeCreateAdjustment(
  env: AppEnv["Bindings"],
  userId: string,
  plan: Record<string, unknown>,
  task: Record<string, unknown>,
  payload: Record<string, unknown>,
  baseVersion: number,
): Promise<string | null> {
  if (plan.status !== "confirmed") return null;
  let trigger: string | null = null;
  let summary = "";
  let proposal: Record<string, unknown> = {};

  const oldDate = task.scheduled_date as string | null;
  const newDate = payload.scheduledDate as string | undefined | null;
  if (newDate !== undefined && oldDate && newDate && newDate > oldDate) {
    trigger = "task_delay";
    summary = `任务「${task.title}」由 ${oldDate} 延期至 ${newDate}，建议顺延后续依赖任务`;
    proposal = { taskId: task.id, taskBaseVersion: baseVersion + 1, setScheduledDate: newDate };
  } else if (payload.status === "done" && task.estimate_hours != null && payload.actualHours != null) {
    const actual = Number(payload.actualHours);
    const estimate = Number(task.estimate_hours);
    if (actual > estimate * 1.5) {
      trigger = "task_overrun";
      summary = `任务「${task.title}」实际用时 ${actual} 小时，超出预估 ${estimate} 小时的 50%，建议下调同类任务预估`;
      proposal = { taskId: task.id, taskBaseVersion: baseVersion + 1, setEstimateHours: Math.ceil(estimate * 1.5) };
    }
  }
  if (!trigger) return null;

  const id = uuid();
  const now = nowIso();
  await env.DB
    .prepare(
      `INSERT INTO adjustment_suggestions (id, user_id, plan_id, trigger, summary, proposal_json, status, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7, ?7)`,
    )
    .bind(id, userId, plan.id, trigger, summary, JSON.stringify(proposal), now)
    .run();
  return id;
}
