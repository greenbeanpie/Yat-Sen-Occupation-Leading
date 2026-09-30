import { pageRows } from "../infra/pagination";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  ErrorBodySchema,
  NotificationListResponseSchema,
  NotificationSchema,
  PushSubscriptionPayloadSchema,
  PushSubscriptionSchema,
  ReminderSettingsSchema,
  UuidSchema,
  UserSettingsResponseSchema,
  VapidPublicKeySchema,
} from "../shared/schemas";
import { requireAuth } from "../middleware/auth";
import { invalidRequest, notFound } from "../shared/errors";
import { nowIso } from "../shared/datetime";
import type { AppEnv } from "../env";

type App = OpenAPIHono<AppEnv>;

const idParam = { name: "id", in: "params" as const, required: true, schema: UuidSchema };

const listNotifications = createRoute({
  method: "get",
  path: "/notifications",
  tags: ["notifications"],
  middleware: [requireAuth] as const,
  responses: {
    200: { content: { "application/json": { schema: NotificationListResponseSchema } }, description: "站内提醒（已发送），附未读数" },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
  },
});

const markRead = createRoute({
  method: "post",
  path: "/notifications/{id}/read",
  tags: ["notifications"],
  middleware: [requireAuth] as const,
  request: { params: z.object({ id: UuidSchema }) },
  responses: {
    200: { content: { "application/json": { schema: NotificationSchema } }, description: "已标记已读" },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
    404: { content: { "application/json": { schema: ErrorBodySchema } }, description: "不存在" },
  },
});

const getSettings = createRoute({
  method: "get",
  path: "/notifications/settings",
  tags: ["notifications"],
  middleware: [requireAuth] as const,
  responses: {
    200: { content: { "application/json": { schema: UserSettingsResponseSchema } }, description: "提醒设置" },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
  },
});

const updateSettings = createRoute({
  method: "put",
  path: "/notifications/settings",
  tags: ["notifications"],
  middleware: [requireAuth] as const,
  request: { body: { content: { "application/json": { schema: ReminderSettingsSchema } }, required: true } },
  responses: {
    200: { content: { "application/json": { schema: UserSettingsResponseSchema } }, description: "已更新提醒设置" },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
  },
});

const subscribe = createRoute({
  method: "post",
  path: "/push-subscriptions",
  tags: ["notifications"],
  middleware: [requireAuth] as const,
  request: { body: { content: { "application/json": { schema: PushSubscriptionPayloadSchema } }, required: true } },
  responses: {
    201: { content: { "application/json": { schema: PushSubscriptionSchema } }, description: "推送订阅已保存（用户主动授权后）" },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
  },
});

const unsubscribe = createRoute({
  method: "delete",
  path: "/push-subscriptions/{id}",
  tags: ["notifications"],
  middleware: [requireAuth] as const,
  request: { params: z.object({ id: UuidSchema }) },
  responses: {
    204: { description: "已取消订阅" },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
    404: { content: { "application/json": { schema: ErrorBodySchema } }, description: "不存在" },
  },
});

const vapidKey = createRoute({
  method: "get",
  path: "/push-subscriptions/vapid-public-key",
  tags: ["notifications"],
  middleware: [requireAuth] as const,
  responses: {
    200: { content: { "application/json": { schema: VapidPublicKeySchema } }, description: "VAPID 公钥（未配置时为空串）" },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
  },
});

export function registerNotificationRoutes(app: App): void {
  app.openapi(listNotifications, async (c) => {
    const userId = c.get("user").id;
    const rows = await pageRows(c, `SELECT * FROM reminders WHERE user_id = ?1 AND status = 'sent' ORDER BY fire_at DESC, id DESC`, [userId]);
    const items = rows.results.map((r) => ({
      id: r.id as string,
      kind: r.kind as string,
      title: r.title as string,
      body: r.body as string,
      entity: r.entity as string,
      entityId: r.entity_id as string,
      fireAt: r.fire_at as string,
      sentAt: r.sent_at as string,
      readAt: (r.read_at as string | null) ?? null,
    }));
    const unread = await c.env.DB
      .prepare(`SELECT COUNT(*) AS n FROM reminders WHERE user_id = ?1 AND status = 'sent' AND read_at IS NULL`)
      .bind(userId)
      .first<{ n: number }>();
    return c.json({ items, unreadCount: unread?.n ?? 0, nextCursor: rows.nextCursor }, 200 as const) as never;
  });

  app.openapi(markRead, async (c) => {
    const userId = c.get("user").id;
    const { id } = c.req.valid("param");
    const row = await c.env.DB.prepare(`SELECT * FROM reminders WHERE id = ?1 AND user_id = ?2`).bind(id, userId).first<Record<string, unknown>>();
    if (!row) throw notFound();
    await c.env.DB.prepare(`UPDATE reminders SET read_at = ?2, updated_at = ?2 WHERE id = ?1`).bind(id, nowIso()).run();
    return c.json({ id, readAt: nowIso() } as never, 200 as const);
  });

  app.openapi(getSettings, async (c) => {
    const userId = c.get("user").id;
    const row = await c.env.DB.prepare(`SELECT * FROM users WHERE id = ?1`).bind(userId).first<Record<string, unknown>>();
    if (!row) throw notFound();
    return c.json(
      {
        timezone: row.timezone as string,
        notifyTaskDue: Number(row.notify_task_due) === 1,
        notifyInterview: Number(row.notify_interview) === 1,
        updatedAt: row.updated_at as string,
      },
      200 as const,
    ) as never;
  });

  app.openapi(updateSettings, async (c) => {
    const userId = c.get("user").id;
    const body = c.req.valid("json");
    if (!body.timezone && body.notifyTaskDue === undefined && body.notifyInterview === undefined) {
      throw invalidRequest([{ field: "(body)", issue: "至少提供一项设置" }]);
    }
    const row = await c.env.DB.prepare(`SELECT * FROM users WHERE id = ?1`).bind(userId).first<Record<string, unknown>>();
    if (!row) throw notFound();
    await c.env.DB
      .prepare(`UPDATE users SET timezone = ?2, notify_task_due = ?3, notify_interview = ?4, updated_at = ?5 WHERE id = ?1`)
      .bind(
        userId,
        body.timezone ?? (row.timezone as string),
        body.notifyTaskDue === undefined ? Number(row.notify_task_due) : body.notifyTaskDue ? 1 : 0,
        body.notifyInterview === undefined ? Number(row.notify_interview) : body.notifyInterview ? 1 : 0,
        nowIso(),
      )
      .run();
    const updated = await c.env.DB.prepare(`SELECT * FROM users WHERE id = ?1`).bind(userId).first<Record<string, unknown>>();
    return c.json(
      {
        timezone: updated!.timezone as string,
        notifyTaskDue: Number(updated!.notify_task_due) === 1,
        notifyInterview: Number(updated!.notify_interview) === 1,
        updatedAt: updated!.updated_at as string,
      },
      200 as const,
    ) as never;
  });

  app.openapi(subscribe, async (c) => {
    const userId = c.get("user").id;
    const body = c.req.valid("json");
    const now = nowIso();
    const existing = await c.env.DB
      .prepare(`SELECT id FROM push_subscriptions WHERE user_id = ?1 AND endpoint = ?2`)
      .bind(userId, body.endpoint)
      .first<{ id: string }>();
    const id = existing?.id ?? crypto.randomUUID();
    if (existing) {
      await c.env.DB
        .prepare(`UPDATE push_subscriptions SET p256dh = ?2, auth = ?3, status = 'active', deleted = 0, updated_at = ?4 WHERE id = ?1`)
        .bind(id, body.keys.p256dh, body.keys.auth, now)
        .run();
    } else {
      await c.env.DB
        .prepare(`INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6, ?6)`)
        .bind(id, userId, body.endpoint, body.keys.p256dh, body.keys.auth, now)
        .run();
    }
    return c.json({ id, endpoint: body.endpoint, status: "active", createdAt: now } as never, 201 as const);
  });

  app.openapi(unsubscribe, async (c) => {
    const userId = c.get("user").id;
    const { id } = c.req.valid("param");
    const row = await c.env.DB.prepare(`SELECT id FROM push_subscriptions WHERE id = ?1 AND user_id = ?2`).bind(id, userId).first();
    if (!row) throw notFound();
    await c.env.DB.prepare(`UPDATE push_subscriptions SET deleted = 1, status = 'expired', updated_at = ?2 WHERE id = ?1`).bind(id, nowIso()).run();
    return c.body(null, 204 as const);
  });

  app.openapi(vapidKey, async (c) => {
    return c.json({ publicKey: c.env.VAPID_PUBLIC_KEY ?? "" }, 200 as const) as never;
  });
}
