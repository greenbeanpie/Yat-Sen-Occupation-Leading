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
import type { MiddlewareHandler } from 'hono';
import { readSession } from '../middleware/auth';
import { isPushConfigured, safePushEndpoint, validPushKeys } from '../infra/push';
import { allowedOrigins } from '../app';
import { forbidden, conflict } from '../shared/errors';
import { requireAuth } from "../middleware/auth";
import { invalidRequest, notFound } from "../shared/errors";
import { nowIso } from "../shared/datetime";
import type { AppEnv } from "../env";

type App = OpenAPIHono<AppEnv>;

const deliveryGuard: MiddlewareHandler<AppEnv> = async (c,next) => {
  c.header('Cache-Control','no-store');
  const expected = c.req.header('X-Notification-Account');
  if (expected && expected !== c.get('user').id) throw conflict('账户已变化，请刷新通知设置后重试',null);
  if (!['GET','OPTIONS'].includes(c.req.method)) {
    const origin = c.req.header('Origin');
    if (!origin || (origin !== new URL(c.req.url).origin && !allowedOrigins(c.env).includes(origin)) || c.req.header('Sec-Fetch-Site') === 'cross-site') throw forbidden('请从本站通知设置提交');
  }
  await next();
};
const notificationVisible = `(entity<>'ticket' OR EXISTS(SELECT 1 FROM support_tickets t JOIN users u ON u.id=reminders.user_id
  WHERE t.id=reminders.entity_id AND u.deleted=0 AND u.disabled=0 AND u.is_demo=0
  AND (t.user_id=u.id OR COALESCE(u.access_role,u.role) IN ('admin','super_admin'))))`;
function toNotice(r: Record<string,unknown>) {
  const entity = String(r.entity);
  return {id:String(r.id),kind:String(r.kind),title:String(r.title),body:String(r.body),entity,entityId:String(r.entity_id),fireAt:String(r.fire_at),sentAt:String(r.sent_at),
    createdAt:String(r.sent_at ?? r.created_at),readAt:(r.read_at as string|null)??null,dismissedAt:(r.dismissed_at as string|null)??null,
    url:entity==='ticket' ? `/tickets/${String(r.entity_id)}` : entity==='task' ? '/plan' : '/applications'};
}
const idParam = { name: "id", in: "params" as const, required: true, schema: UuidSchema };

const listNotifications = createRoute({
  method: "get",
  path: "/notifications",
  tags: ["notifications"],
  middleware: [requireAuth,deliveryGuard] as const,
  responses: {
    200: { content: { "application/json": { schema: NotificationListResponseSchema } }, description: "站内提醒（已发送），附未读数" },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
  },
});

const markRead = createRoute({
  method: "post",
  path: "/notifications/{id}/read",
  tags: ["notifications"],
  middleware: [requireAuth,deliveryGuard] as const,
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
  middleware: [requireAuth,deliveryGuard] as const,
  responses: {
    200: { content: { "application/json": { schema: UserSettingsResponseSchema } }, description: "提醒设置" },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
  },
});

const updateSettings = createRoute({
  method: "put",
  path: "/notifications/settings",
  tags: ["notifications"],
  middleware: [requireAuth,deliveryGuard] as const,
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
  middleware: [requireAuth,deliveryGuard] as const,
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
  middleware: [requireAuth,deliveryGuard] as const,
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
  middleware: [requireAuth,deliveryGuard] as const,
  responses: {
    200: { content: { "application/json": { schema: VapidPublicKeySchema } }, description: "VAPID 公钥（未配置时为空串）" },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
  },
});

export function registerNotificationRoutes(app: App): void {
  app.openapi(listNotifications, async (c) => {
    const userId = c.get("user").id;
    const rows = await pageRows(c, `SELECT * FROM reminders WHERE user_id = ?1 AND status = 'sent' AND ${notificationVisible} ORDER BY fire_at DESC, id DESC`, [userId]);
    const items = rows.results.map(toNotice);
    const unread = await c.env.DB
      .prepare(`SELECT COUNT(*) AS n FROM reminders WHERE user_id = ?1 AND status = 'sent' AND read_at IS NULL AND dismissed_at IS NULL AND ${notificationVisible}`)
      .bind(userId)
      .first<{ n: number }>();
    return c.json({ items, unreadCount: unread?.n ?? 0, nextCursor: rows.nextCursor }, 200 as const) as never;
  });

  app.openapi(markRead, async (c) => {
    const userId = c.get("user").id;
    const { id } = c.req.valid("param");
    const row = await c.env.DB.prepare(`SELECT * FROM reminders WHERE id = ?1 AND user_id = ?2 AND ${notificationVisible}`).bind(id, userId).first<Record<string, unknown>>();
    if (!row) throw notFound();
    await c.env.DB.prepare(`UPDATE reminders SET read_at = ?2, updated_at = ?2 WHERE id = ?1`).bind(id, nowIso()).run();
    return c.json({...toNotice(row),readAt:nowIso()} as never, 200 as const);
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
        inAppEnabled: Number(row.notify_in_app) === 1,
        pushEnabled: Number(row.notify_push) === 1,
        updatedAt: row.updated_at as string,
      },
      200 as const,
    ) as never;
  });

  app.openapi(updateSettings, async (c) => {
    const userId = c.get("user").id;
    const body = c.req.valid("json");
    if (!body.timezone && body.notifyTaskDue === undefined && body.notifyInterview === undefined && body.inAppEnabled === undefined && body.pushEnabled === undefined) {
      throw invalidRequest([{ field: "(body)", issue: "至少提供一项设置" }]);
    }
    const row = await c.env.DB.prepare(`SELECT * FROM users WHERE id = ?1`).bind(userId).first<Record<string, unknown>>();
    if (!row) throw notFound();
    await c.env.DB
      .prepare(`UPDATE users SET timezone = ?2, notify_task_due = ?3, notify_interview = ?4, updated_at = ?5, notify_in_app = ?6, notify_push = ?7 WHERE id = ?1`)
      .bind(
        userId,
        body.timezone ?? (row.timezone as string),
        body.notifyTaskDue === undefined ? Number(row.notify_task_due) : body.notifyTaskDue ? 1 : 0,
        body.notifyInterview === undefined ? Number(row.notify_interview) : body.notifyInterview ? 1 : 0,
        nowIso(),
        body.inAppEnabled === undefined ? Number(row.notify_in_app) : body.inAppEnabled ? 1 : 0,
        body.pushEnabled === undefined ? Number(row.notify_push) : body.pushEnabled ? 1 : 0,
      )
      .run();
    const updated = await c.env.DB.prepare(`SELECT * FROM users WHERE id = ?1`).bind(userId).first<Record<string, unknown>>();
    return c.json(
      {
        timezone: updated!.timezone as string,
        notifyTaskDue: Number(updated!.notify_task_due) === 1,
        notifyInterview: Number(updated!.notify_interview) === 1,
        inAppEnabled: Number(updated!.notify_in_app) === 1,
        pushEnabled: Number(updated!.notify_push) === 1,
        updatedAt: updated!.updated_at as string,
      },
      200 as const,
    ) as never;
  });

  const device = z.object({id:UuidSchema.nullable()}).openapi('NotificationPushDevice');
  const statusSchema = z.object({configured:z.boolean(),publicKey:z.string()}).openapi('NotificationPushStatus');
  const response = (schema:z.ZodType,description:string) => ({content:{'application/json':{schema}},description});
  const middleware = [requireAuth,deliveryGuard];
  const saveSubscription = async (c: import('hono').Context<AppEnv>) => {
    const user = c.get('user');
    if (user.demo) throw forbidden('演示身份不能注册系统推送');
    if (!isPushConfigured(c.env)) throw conflict('系统推送尚未配置，站内通知仍可用',null);
    const body = PushSubscriptionPayloadSchema.parse(await c.req.json());
    if (!safePushEndpoint(body.endpoint) || !await validPushKeys(body.keys.p256dh,body.keys.auth)) throw invalidRequest([{field:'endpoint/keys',issue:'需要受支持的 HTTPS 推送服务和有效订阅密钥'}]);
    const session = await readSession(c); if (!session) throw forbidden();
    const now=nowIso(), id=crypto.randomUUID();
    const owned = await c.env.DB.prepare(`SELECT id FROM push_subscriptions WHERE endpoint=?1 AND user_id<>?2 AND deleted=0 AND status='active'`).bind(body.endpoint,user.id).first();
    if (owned) throw conflict('此设备订阅属于其他账户，请取消旧订阅后重新开启',null);
    const result = await c.env.DB.prepare(`INSERT INTO push_subscriptions(id,user_id,endpoint,p256dh,auth,status,created_at,updated_at,session_id)
      SELECT ?1,?2,?3,?4,?5,'active',?6,?6,?7 WHERE NOT EXISTS(SELECT 1 FROM push_subscriptions WHERE endpoint=?3 AND user_id<>?2 AND deleted=0 AND status='active')
      ON CONFLICT(user_id,endpoint) DO UPDATE SET p256dh=excluded.p256dh,auth=excluded.auth,status='active',deleted=0,updated_at=excluded.updated_at,session_id=excluded.session_id`)
      .bind(id,user.id,body.endpoint,body.keys.p256dh,body.keys.auth,now,session.jti).run();
    if (result.meta.changes!==1) throw conflict('设备订阅归属已变化，请重试',null);
    const saved = await c.env.DB.prepare('SELECT id,created_at FROM push_subscriptions WHERE user_id=?1 AND endpoint=?2').bind(user.id,body.endpoint).first<{id:string;created_at:string}>();
    return c.json({id:saved!.id,endpoint:body.endpoint,status:'active',createdAt:saved!.created_at},201);
  };
  const deleteSubscription = async (c: import('hono').Context<AppEnv>) => {
    const id = c.req.param('id');
    await c.env.DB.prepare(`UPDATE push_subscriptions SET deleted=1,status='expired',updated_at=?3 WHERE id=?1 AND user_id=?2`).bind(id,c.get('user').id,nowIso()).run();
    return c.body(null,204);
  };
  app.openapi(subscribe,saveSubscription as never);
  app.openapi(unsubscribe,deleteSubscription as never);
  app.openapi(createRoute({method:'post',path:'/notifications/push/subscriptions',tags:['notifications'],middleware,request:{body:{required:true,content:{'application/json':{schema:PushSubscriptionPayloadSchema}}}},responses:{201:response(PushSubscriptionSchema,'当前账户的设备订阅')} }),saveSubscription as never);
  app.openapi(createRoute({method:'delete',path:'/notifications/push/subscriptions/{id}',tags:['notifications'],middleware,request:{params:z.object({id:UuidSchema})},responses:{204:{description:'当前账户设备取消；幂等'}}}),deleteSubscription as never);
  app.openapi(createRoute({method:'get',path:'/notifications/push/status',tags:['notifications'],middleware,responses:{200:response(statusSchema,'推送是否配置，不返回私钥')}}),async c => c.json({configured:isPushConfigured(c.env),publicKey:isPushConfigured(c.env)?c.env.VAPID_PUBLIC_KEY! : ''},200));
  app.openapi(createRoute({method:'post',path:'/notifications/push/lookup',tags:['notifications'],middleware,request:{body:{required:true,content:{'application/json':{schema:z.object({endpoint:z.string().url().max(2048)})}}}},responses:{200:response(device,'仅返回当前账户拥有的有效订阅')} }),async c => {
    const body=c.req.valid('json');
    const row=await c.env.DB.prepare(`SELECT id FROM push_subscriptions WHERE user_id=?1 AND endpoint=?2 AND deleted=0 AND status='active'`).bind(c.get('user').id,body.endpoint).first<{id:string}>();
    return c.json({id:row?.id??null},200);
  });
  app.openapi(createRoute({method:'post',path:'/notifications/{id}/dismiss',tags:['notifications'],middleware,request:{params:z.object({id:UuidSchema})},responses:{200:response(NotificationSchema,'收起但保留历史')} }),async c => {
    const id=c.req.valid('param').id;
    const row=await c.env.DB.prepare(`SELECT * FROM reminders WHERE id=?1 AND user_id=?2 AND ${notificationVisible}`).bind(id,c.get('user').id).first<Record<string,unknown>>();
    if (!row) throw notFound();
    const now=nowIso();
    await c.env.DB.prepare(`UPDATE reminders SET dismissed_at=COALESCE(dismissed_at,?3),read_at=COALESCE(read_at,?3),updated_at=?3 WHERE id=?1 AND user_id=?2`).bind(id,c.get('user').id,now).run();
    return c.json({...toNotice(row),dismissedAt:row.dismissed_at??now,readAt:row.read_at??now},200);
  });

  app.openapi(vapidKey, async (c) => {
    return c.json({ publicKey: c.env.VAPID_PUBLIC_KEY ?? "" }, 200 as const) as never;
  });
}
