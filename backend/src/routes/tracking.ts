import { pageRows } from "../infra/pagination";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  ApplicationEventPayloadSchema,
  ApplicationEventSchema,
  ApplicationPayloadSchema,
  ApplicationSchema,
  ApplicationStatusSchema,
  EfficiencyStatsSchema,
  ErrorBodySchema,
  InterviewPayloadSchema,
  InterviewSchema,
  TimeEntryPayloadSchema,
  TimeEntrySchema,
  UuidSchema,
} from "../shared/schemas";
import { requireAuth } from "../middleware/auth";
import { conflict, invalidRequest, notFound } from "../shared/errors";
import { APPLICATION_EVENT_CFG, APPLICATION_CFG, INTERVIEW_CFG, TIME_ENTRY_CFG } from "../application/configs";
import { createEntity, deleteEntity, rowToJson, updateEntity } from "../application/entity-writer";
import { canTransition } from "../domain/state";
import { DateYmdSchema } from "../shared/schemas/common";
import { nowIso, uuid } from "../shared/datetime";
import { scheduleInterviewReminder } from "../application/reminders";
import { applySyncOperation } from "../application/sync";
import { restoreApplication as restoreApplicationRecord } from "../application/tracking";
import type { AppEnv } from "../env";

type App = OpenAPIHono<AppEnv>;

const idParam = { name: "id", in: "params" as const, required: true, schema: UuidSchema };

const createApplication = createRoute({
  method: "post",
  path: "/applications",
  tags: ["applications"],
  middleware: [requireAuth] as const,
  request: { body: { content: { "application/json": { schema: ApplicationPayloadSchema.extend({ creationId: UuidSchema.optional().describe("同一次创建及离线重试共用的 UUID") }) } }, required: true } },
  responses: {
    201: { content: { "application/json": { schema: ApplicationSchema } }, description: "已创建投递记录" },
    409: { content: { "application/json": { schema: ErrorBodySchema } }, description: "创建标识冲突" },
    422: { content: { "application/json": { schema: ErrorBodySchema } }, description: "创建请求有误" },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
  },
});

const listApplications = createRoute({
  method: "get",
  path: "/applications",
  tags: ["applications"],
  middleware: [requireAuth] as const,
  request: { query: z.object({ archived: z.enum(["true", "false"]).optional() }) },
  responses: {
    200: { content: { "application/json": { schema: z.object({ items: z.array(ApplicationSchema), nextCursor: z.string().nullable().optional() }) } }, description: "投递列表" },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
  },
});

const getApplication = createRoute({
  method: "get",
  path: "/applications/{id}",
  tags: ["applications"],
  middleware: [requireAuth] as const,
  request: { params: z.object({ id: UuidSchema }) },
  responses: {
    200: { content: { "application/json": { schema: ApplicationSchema } }, description: "投递详情" },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
    404: { content: { "application/json": { schema: ErrorBodySchema } }, description: "不存在" },
  },
});

const updateApplication = createRoute({
  method: "patch",
  path: "/applications/{id}",
  tags: ["applications"],
  middleware: [requireAuth] as const,
  request: {
    params: z.object({ id: UuidSchema }),
    body: { content: { "application/json": { schema: ApplicationPayloadSchema.partial().extend({ baseVersion: z.number().int() }) } }, required: true },
  },
  responses: {
    200: { content: { "application/json": { schema: ApplicationSchema } }, description: "已更新（状态变化记录历史）" },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
    409: { content: { "application/json": { schema: ErrorBodySchema } }, description: "版本冲突" },
  },
});

const deleteApplication = createRoute({
  method: "delete",
  path: "/applications/{id}",
  tags: ["applications"],
  middleware: [requireAuth] as const,
  request: { params: z.object({ id: UuidSchema }) },
  responses: {
    204: { description: "已归档（保留关联历史，可恢复）" },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
    404: { content: { "application/json": { schema: ErrorBodySchema } }, description: "不存在" },
  },
});

const restoreApplication = createRoute({
  method: "post",
  path: "/applications/{id}/restore",
  tags: ["applications"],
  middleware: [requireAuth] as const,
  request: {
    params: z.object({ id: UuidSchema }),
    body: { content: { "application/json": { schema: z.object({ baseVersion: z.number().int().positive() }) } }, required: true },
  },
  responses: {
    200: { content: { "application/json": { schema: ApplicationSchema } }, description: "投递及关联记录已恢复到活动视图；不补发过期提醒" },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
    404: { content: { "application/json": { schema: ErrorBodySchema } }, description: "不存在" },
    409: { content: { "application/json": { schema: ErrorBodySchema } }, description: "版本冲突" },
  },
});

const listEvents = createRoute({
  method: "get",
  path: "/applications/{id}/events",
  tags: ["applications"],
  middleware: [requireAuth] as const,
  request: { params: z.object({ id: UuidSchema }) },
  responses: {
    200: { content: { "application/json": { schema: z.object({ items: z.array(ApplicationEventSchema), nextCursor: z.string().nullable().optional() }) } }, description: "状态历史与反馈" },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
  },
});

const createEvent = createRoute({
  method: "post",
  path: "/applications/{id}/events",
  tags: ["applications"],
  middleware: [requireAuth] as const,
  request: {
    params: z.object({ id: UuidSchema }),
    body: { content: { "application/json": { schema: ApplicationEventPayloadSchema } }, required: true },
  },
  responses: {
    201: { content: { "application/json": { schema: ApplicationEventSchema } }, description: "已记录事件（状态变化校验状态机）" },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
    422: { content: { "application/json": { schema: ErrorBodySchema } }, description: "非法状态流转" },
  },
});

const scheduleInterview = createRoute({
  method: "post",
  path: "/applications/{id}/interviews",
  tags: ["applications"],
  middleware: [requireAuth] as const,
  request: {
    params: z.object({ id: UuidSchema }),
    body: { content: { "application/json": { schema: InterviewPayloadSchema } }, required: true },
  },
  responses: {
    201: { content: { "application/json": { schema: InterviewSchema } }, description: "面试已安排（默认提前 1 小时提醒）" },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
  },
});

const listInterviews = createRoute({
  method: "get",
  path: "/applications/{id}/interviews",
  tags: ["applications"],
  middleware: [requireAuth] as const,
  request: { params: z.object({ id: UuidSchema }) },
  responses: {
    200: { content: { "application/json": { schema: z.object({ items: z.array(InterviewSchema), nextCursor: z.string().nullable().optional() }) } }, description: "面试安排" },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
  },
});

const updateInterview = createRoute({
  method: "patch",
  path: "/interviews/{id}",
  tags: ["applications"],
  middleware: [requireAuth] as const,
  request: {
    params: z.object({ id: UuidSchema }),
    body: { content: { "application/json": { schema: InterviewPayloadSchema.partial().extend({ result: z.enum(["pending", "passed", "failed"]).optional(), feedback: z.string().max(5000).nullish(), baseVersion: z.number().int() }) } }, required: true },
  },
  responses: {
    200: { content: { "application/json": { schema: InterviewSchema } }, description: "已更新（改期会重排提醒）" },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
    409: { content: { "application/json": { schema: ErrorBodySchema } }, description: "版本冲突" },
  },
});

const createTimeEntry = createRoute({
  method: "post",
  path: "/time-entries",
  tags: ["time-entries"],
  middleware: [requireAuth] as const,
  request: { body: { content: { "application/json": { schema: TimeEntryPayloadSchema } }, required: true } },
  responses: {
    201: { content: { "application/json": { schema: TimeEntrySchema } }, description: "工时已录入" },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
  },
});

const listTimeEntries = createRoute({
  method: "get",
  path: "/time-entries",
  tags: ["time-entries"],
  middleware: [requireAuth] as const,
  request: { query: z.object({ from: DateYmdSchema, to: DateYmdSchema }) },
  responses: {
    200: { content: { "application/json": { schema: z.object({ items: z.array(TimeEntrySchema), nextCursor: z.string().nullable().optional() }) } }, description: "工时记录" },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
  },
});

const deleteTimeEntry = createRoute({
  method: "delete",
  path: "/time-entries/{id}",
  tags: ["time-entries"],
  middleware: [requireAuth] as const,
  request: { params: z.object({ id: UuidSchema }) },
  responses: {
    204: { description: "已删除（墓碑）" },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
    404: { content: { "application/json": { schema: ErrorBodySchema } }, description: "不存在" },
  },
});

const getStats = createRoute({
  method: "get",
  path: "/applications/stats",
  tags: ["applications"],
  middleware: [requireAuth] as const,
  request: { query: z.object({ from: DateYmdSchema, to: DateYmdSchema }) },
  responses: {
    200: { content: { "application/json": { schema: EfficiencyStatsSchema } }, description: "效率统计（零工时返回 data=null）" },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
  },
});

export function registerTrackingRoutes(app: App): void {
  // 注意：stats 必须先于 /applications/{id} 注册，避免 "stats" 被当作 UUID 参数
  app.openapi(getStats, async (c) => {
    const userId = c.get("user").id;
    const { from, to } = c.req.valid("query");
    // 获得面试的去重投递数：时间范围内进入面试状态的投递（按事件去重）
    const interviewed = await c.env.DB
      .prepare(
        `SELECT COUNT(DISTINCT application_id) AS n FROM application_events
         WHERE user_id = ?1 AND deleted = 0 AND type = 'status_change' AND to_status = 'interviewing'
           AND occurred_at >= ?2 AND occurred_at < ?3
           AND EXISTS (SELECT 1 FROM applications a WHERE a.id = application_events.application_id AND a.user_id = ?1 AND a.deleted = 0)`,
      )
      .bind(userId, `${from}T00:00:00.000Z`, `${to}T23:59:59.999Z`)
      .first<{ n: number }>();
    const hoursRow = await c.env.DB
      .prepare(`SELECT COALESCE(SUM(minutes), 0) AS total FROM time_entries WHERE user_id = ?1 AND deleted = 0 AND spent_on >= ?2 AND spent_on <= ?3
        AND (application_id IS NULL OR EXISTS (SELECT 1 FROM applications a WHERE a.id = time_entries.application_id AND a.user_id = ?1 AND a.deleted = 0))`)
      .bind(userId, from, to)
      .first<{ total: number }>();
    const interviewedCount = interviewed?.n ?? 0;
    const totalHours = (hoursRow?.total ?? 0) / 60;
    // 效率 = 获得面试的去重投递数 ÷ 实际工时 × 10；零工时显示暂无数据（PLAN.md 三）
    const efficiency = totalHours > 0 ? (interviewedCount / totalHours) * 10 : null;
    return c.json({ from, to, interviewedCount, totalHours, efficiency } as never, 200 as const);
  });

  app.openapi(createApplication, async (c) => {
    const userId = c.get("user").id;
    const { creationId = uuid(), ...payload } = c.req.valid("json");
    const result = await applySyncOperation(c.env, userId, {
      opId: creationId, entity: "application", entityId: creationId,
      baseVersion: 0, action: "upsert", payload,
    });
    if (result.status === "conflict") throw conflict(result.error ?? "创建标识冲突", result.record);
    if (result.status === "rejected") throw invalidRequest(result.details ?? [], result.error);
    return c.json(result.record as never, 201 as const);
  });

  app.openapi(listApplications, async (c) => {
    const userId = c.get("user").id;
    const archived = c.req.valid("query").archived === "true" ? 1 : 0;
    const rows = await pageRows(c, `SELECT * FROM applications WHERE user_id = ?1 AND deleted = ?2 ORDER BY created_at DESC, id DESC`, [userId, archived]);
    return c.json({ items: rows.results.map((r) => rowToJson(APPLICATION_CFG, r)), nextCursor: rows.nextCursor }, 200 as const) as never;
  });

  app.openapi(getApplication, async (c) => {
    const userId = c.get("user").id;
    const { id } = c.req.valid("param");
    const row = await c.env.DB.prepare(`SELECT * FROM applications WHERE id = ?1 AND user_id = ?2`).bind(id, userId).first<Record<string, unknown>>();
    if (!row) throw notFound();
    return c.json(rowToJson(APPLICATION_CFG, row) as never, 200 as const);
  });

  app.openapi(updateApplication, async (c) => {
    const userId = c.get("user").id;
    const { id } = c.req.valid("param");
    const body = c.req.valid("json") as Record<string, unknown> & { baseVersion: number };
    const { baseVersion, ...payload } = body;
    const existing = await c.env.DB.prepare(`SELECT * FROM applications WHERE id = ?1 AND user_id = ?2 AND deleted = 0`).bind(id, userId).first<Record<string, unknown>>();
    if (!existing) throw notFound();

    const toStatus = payload.status as string | undefined;
    if (toStatus && !canTransition(existing.status as string, toStatus)) {
      throw invalidRequest([{ field: "status", issue: `投递不能从 ${existing.status} 变为 ${toStatus}` }]);
    }
    const { record } = await updateEntity(c.env, userId, APPLICATION_CFG, id, baseVersion, payload);
    if (toStatus && toStatus !== existing.status) {
      await createEntity(c.env, userId, APPLICATION_EVENT_CFG, {
        applicationId: id,
        type: "status_change",
        fromStatus: existing.status,
        toStatus,
        occurredAt: nowIso(),
      });
    }
    return c.json(record as never, 200 as const);
  });

  app.openapi(deleteApplication, async (c) => {
    const userId = c.get("user").id;
    const { id } = c.req.valid("param");
    await deleteEntity(c.env, userId, APPLICATION_CFG, id);
    return c.body(null, 204 as const);
  });

  app.openapi(restoreApplication, async (c) => {
    const record = await restoreApplicationRecord(c.env, c.get("user").id, c.req.valid("param").id, c.req.valid("json").baseVersion);
    return c.json(record as never, 200 as const);
  });

  app.openapi(listEvents, async (c) => {
    const userId = c.get("user").id;
    const { id } = c.req.valid("param");
    const rows = await pageRows(c, `SELECT * FROM application_events WHERE application_id = ?1 AND user_id = ?2 AND deleted = 0 ORDER BY occurred_at DESC, id DESC`, [id, userId]);
    return c.json({ items: rows.results.map((r) => rowToJson(APPLICATION_EVENT_CFG, r)), nextCursor: rows.nextCursor }, 200 as const) as never;
  });

  app.openapi(createEvent, async (c) => {
    const userId = c.get("user").id;
    const { id } = c.req.valid("param");
    const payload = c.req.valid("json");
    const existing = await c.env.DB.prepare(`SELECT * FROM applications WHERE id = ?1 AND user_id = ?2 AND deleted = 0`).bind(id, userId).first<Record<string, unknown>>();
    if (!existing) throw notFound();
    if (payload.type === "status_change") {
      if (!payload.toStatus) throw invalidRequest([{ field: "toStatus", issue: "状态变化事件必须提供 toStatus" }]);
      if (!canTransition(existing.status as string, payload.toStatus as string)) {
        throw invalidRequest([{ field: "toStatus", issue: `投递不能从 ${existing.status} 变为 ${payload.toStatus}` }]);
      }
      await updateEntity(c.env, userId, APPLICATION_CFG, id, Number(existing.version), { status: payload.toStatus });
    }
    const { record } = await createEntity(c.env, userId, APPLICATION_EVENT_CFG, {
      applicationId: id,
      type: payload.type,
      fromStatus: payload.type === "status_change" ? existing.status : null,
      toStatus: payload.toStatus ?? null,
      note: payload.note ?? null,
      occurredAt: payload.occurredAt ?? nowIso(),
    } as Record<string, unknown>);
    return c.json(record as never, 201 as const);
  });

  app.openapi(scheduleInterview, async (c) => {
    const userId = c.get("user").id;
    const { id } = c.req.valid("param");
    const payload = c.req.valid("json");
    const existing = await c.env.DB.prepare(`SELECT * FROM applications WHERE id = ?1 AND user_id = ?2 AND deleted = 0`).bind(id, userId).first<Record<string, unknown>>();
    if (!existing) throw notFound();
    const { record } = await createEntity(c.env, userId, INTERVIEW_CFG, { applicationId: id, ...payload } as Record<string, unknown>);
    // 面试默认提前 1 小时提醒（绑定面试版本，改期自动重排）
    await scheduleInterviewReminder(c.env, userId, record.id as string, 1, (payload.stage ?? "面试") as string, payload.scheduledAt as string);
    return c.json(record as never, 201 as const);
  });

  app.openapi(listInterviews, async (c) => {
    const userId = c.get("user").id;
    const { id } = c.req.valid("param");
    const rows = await pageRows(c, `SELECT * FROM interviews WHERE application_id = ?1 AND user_id = ?2 AND deleted = 0 ORDER BY scheduled_at, id DESC`, [id, userId]);
    return c.json({ items: rows.results.map((r) => rowToJson(INTERVIEW_CFG, r)), nextCursor: rows.nextCursor }, 200 as const) as never;
  });

  app.openapi(updateInterview, async (c) => {
    const userId = c.get("user").id;
    const { id } = c.req.valid("param");
    const body = c.req.valid("json") as Record<string, unknown> & { baseVersion: number };
    const { baseVersion, ...payload } = body;
    const { record } = await updateEntity(c.env, userId, INTERVIEW_CFG, id, baseVersion, payload);
    // 改期重排提醒
    if (payload.scheduledAt !== undefined) {
      await scheduleInterviewReminder(c.env, userId, id, Number(record.version), (record.stage as string) ?? "面试", payload.scheduledAt as string);
    }
    return c.json(record as never, 200 as const);
  });

  app.openapi(createTimeEntry, async (c) => {
    const userId = c.get("user").id;
    const payload = c.req.valid("json");
    const { record } = await createEntity(c.env, userId, TIME_ENTRY_CFG, payload as Record<string, unknown>);
    return c.json(record as never, 201 as const);
  });

  app.openapi(listTimeEntries, async (c) => {
    const userId = c.get("user").id;
    const { from, to } = c.req.valid("query");
    const rows = await pageRows(c, `SELECT * FROM time_entries WHERE user_id = ?1 AND deleted = 0 AND spent_on >= ?2 AND spent_on <= ?3 ORDER BY spent_on, id DESC`, [userId, from, to]);
    return c.json({ items: rows.results.map((r) => rowToJson(TIME_ENTRY_CFG, r)), nextCursor: rows.nextCursor }, 200 as const) as never;
  });

  app.openapi(deleteTimeEntry, async (c) => {
    const userId = c.get("user").id;
    const { id } = c.req.valid("param");
    await deleteEntity(c.env, userId, TIME_ENTRY_CFG, id);
    return c.body(null, 204 as const);
  });
}
