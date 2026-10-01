import { cronTick } from '../application/reminders';
import { sendWebPush } from '../infra/push';
import { ticketNotificationStatements } from '../application/ticket-notifications';
import { createRoute, z } from '@hono/zod-openapi';
import type { Context, MiddlewareHandler } from 'hono';
import { allowedOrigins, type App } from '../app';
import type { AppEnv } from '../env';
import { requireAuth } from '../middleware/auth';
import { ErrorBodySchema, UuidSchema } from '../shared/schemas';
import { forbidden, notFound, conflict, invalidRequest } from '../shared/errors';
import { nowIso, uuid } from '../shared/datetime';
import { rateLimit } from '../infra/rate-limit';

const Status = z.enum(['pending', 'in_progress', 'waiting_user', 'resolved', 'closed']);
const text = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/u, '内容不能包含控制字符');
const Ticket = z.object({ id: UuidSchema, subject: z.string(), status: Status, createdAt: z.string(), updatedAt: z.string() }).openapi('SupportTicket');
const Message = z.object({ id: UuidSchema, body: z.string(), authorName: z.string(), isStaff: z.boolean(), createdAt: z.string() }).openapi('SupportTicketMessage');
const Detail = Ticket.extend({ messages: z.array(Message), messagesNextCursor: z.string().nullable() }).openapi('SupportTicketDetail');
const List = z.object({ items: z.array(Ticket), nextCursor: z.string().nullable() }).openapi('SupportTicketList');
const Params = z.object({ id: UuidSchema });
const Page = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20), cursor: z.string().max(256).optional() });
const errors = {
  401: { content: { 'application/json': { schema: ErrorBodySchema } }, description: '未登录' },
  403: { content: { 'application/json': { schema: ErrorBodySchema } }, description: '需要真实账户或管理员权限' },
  404: { content: { 'application/json': { schema: ErrorBodySchema } }, description: '工单不存在或不可访问' },
  409: { content: { 'application/json': { schema: ErrorBodySchema } }, description: '工单已关闭或权限已变化' },
  422: { content: { 'application/json': { schema: ErrorBodySchema } }, description: '参数错误' },
  429: { content: { 'application/json': { schema: ErrorBodySchema } }, description: '请求过于频繁' },
};
const ticketGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.header('Cache-Control', 'no-store');
  if (c.get('user').demo) throw forbidden('演示身份不能使用支持工单');
  if (c.req.method !== 'GET') {
    const origin = c.req.header('Origin');
    if (!origin || (origin !== new URL(c.req.url).origin && !allowedOrigins(c.env).includes(origin)) || c.req.header('Sec-Fetch-Site') === 'cross-site') throw forbidden('请从本站工单页面提交');
    if (!/^application\/json(?:;|$)/i.test(c.req.header('Content-Type') ?? '')) throw forbidden('需要 JSON 请求');
  }
  await next();
};
const middleware = [requireAuth, ticketGuard] as const;
const isStaff = (role: string) => role === 'admin' || role === 'super_admin';
const actorActive = `EXISTS (SELECT 1 FROM users actor WHERE actor.id=?1 AND actor.deleted=0 AND actor.disabled=0 AND actor.is_demo=0)`;
const actorStaff = `EXISTS (SELECT 1 FROM users actor WHERE actor.id=?1 AND actor.deleted=0 AND actor.disabled=0 AND actor.is_demo=0 AND COALESCE(actor.access_role,actor.role) IN ('admin','super_admin'))`;
const visible = `(user_id=?1 OR ${actorStaff})`;
const Cursor = z.object({ time: z.string().datetime(), id: UuidSchema }).strict();
function decodeCursor(raw?: string): z.infer<typeof Cursor> | null {
  if (!raw) return null;
  try { return Cursor.parse(JSON.parse(atob(raw))); }
  catch { throw invalidRequest([{ field: 'cursor', issue: '分页游标无效' }]); }
}
function cursor(row: Record<string, unknown>) { return btoa(JSON.stringify({ time: row.created_at, id: row.id })); }
function ticket(row: Record<string, unknown>): z.infer<typeof Ticket> {
  return { id: String(row.id), subject: String(row.subject), status: row.status as z.infer<typeof Status>, createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
}
async function detail(c: Context<AppEnv>, id: string, before?: string, limit = 50): Promise<z.infer<typeof Detail>> {
  const row = await c.env.DB.prepare(`SELECT * FROM support_tickets WHERE id=?2 AND ${visible} AND ${actorActive}`).bind(c.get('user').id, id).first<Record<string, unknown>>();
  if (!row) throw notFound('工单不存在或不可访问');
  const page = decodeCursor(before);
  const rows = await c.env.DB.prepare(`SELECT m.id,m.body,m.is_staff,m.created_at,COALESCE(u.display_name,'已停用用户') AS author_name
    FROM support_ticket_messages m LEFT JOIN users u ON u.id=m.author_id
    WHERE m.ticket_id=?1 AND (?2 IS NULL OR m.created_at<?2 OR (m.created_at=?2 AND m.id<?3))
    ORDER BY m.created_at DESC,m.id DESC LIMIT ?4`).bind(id, page?.time ?? null, page?.id ?? null, limit + 1).all<Record<string, unknown>>();
  const records = rows.results.slice(0,limit);
  return { ...ticket(row), messagesNextCursor: rows.results.length > limit ? cursor(records[records.length - 1]!) : null,
    messages: records.reverse().map(r => ({ id: String(r.id), body: String(r.body), authorName: String(r.author_name), isStaff: r.is_staff === 1, createdAt: String(r.created_at) })) };
}

export function registerTicketRoutes(app: App): void {
  app.openapi(createRoute({ method: 'get', path: '/tickets', tags: ['tickets'], middleware: [...middleware], request: { query: Page },
    responses: { 200: { content: { 'application/json': { schema: List } }, description: '用户仅查看自己的工单；管理员查看全部' }, ...errors },
  }), async c => {
    const input = c.req.valid('query'), page = decodeCursor(input.cursor);
    const rows = await c.env.DB.prepare(`SELECT * FROM support_tickets WHERE ${visible} AND ${actorActive}
      AND (?2 IS NULL OR created_at<?2 OR (created_at=?2 AND id<?3)) ORDER BY created_at DESC,id DESC LIMIT ?4`)
      .bind(c.get('user').id, page?.time ?? null, page?.id ?? null, input.limit + 1).all<Record<string, unknown>>();
    const records = rows.results.slice(0,input.limit);
    return c.json({ items: records.map(ticket), nextCursor: rows.results.length > input.limit ? cursor(records[records.length - 1]!) : null }, 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/tickets', tags: ['tickets'], middleware: [...middleware],
    request: { body: { required: true, content: { 'application/json': { schema: z.object({ subject: text(160), body: text(5000) }).strict() } } } },
    responses: { 201: { content: { 'application/json': { schema: Detail } }, description: '工单已提交' }, ...errors },
  }), async c => {
    const actor = c.get('user'), input = c.req.valid('json'), id = uuid(), now = nowIso();
    await rateLimit(c.env, `ticket-create:${actor.id}`, 5, 300);
    const notices = await ticketNotificationStatements(c.env,id,actor.id,`ticket-created:${id}`,'ticket_created');
    const results = await c.env.DB.batch([
      c.env.DB.prepare(`INSERT INTO support_tickets (id,user_id,subject,status,created_at,updated_at) SELECT ?2,?1,?3,'pending',?4,?4 WHERE ${actorActive}`).bind(actor.id,id,input.subject,now),
      c.env.DB.prepare(`INSERT INTO support_ticket_messages (id,ticket_id,author_id,is_staff,body,created_at) SELECT ?2,?3,?1,CASE WHEN ${actorStaff} THEN 1 ELSE 0 END,?4,?5 WHERE EXISTS (SELECT 1 FROM support_tickets WHERE id=?3)`)
        .bind(actor.id,uuid(),id,input.body,now),
      ...notices,
    ]);
    if (results[0]!.meta.changes !== 1) throw forbidden();
    c.executionCtx.waitUntil(cronTick(c.env,nowIso(),sendWebPush,{ticketsOnly:true}));
    return c.json(await detail(c,id), 201);
  });
  app.openapi(createRoute({ method: 'get', path: '/tickets/{id}', tags: ['tickets'], middleware: [...middleware],
    request: { params: Params, query: z.object({ before: z.string().max(256).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }) },
    responses: { 200: { content: { 'application/json': { schema: Detail } }, description: '工单与最新消息；before 分页读取更早消息' }, ...errors },
  }), async c => c.json(await detail(c,c.req.valid('param').id,c.req.valid('query').before,c.req.valid('query').limit), 200));
  app.openapi(createRoute({ method: 'post', path: '/tickets/{id}/messages', tags: ['tickets'], middleware: [...middleware],
    request: { params: Params, body: { required: true, content: { 'application/json': { schema: z.object({ body: text(5000) }).strict() } } } },
    responses: { 200: { content: { 'application/json': { schema: Detail } }, description: '回复已保存；已关闭工单需管理员重新打开' }, ...errors },
  }), async c => {
    const id = c.req.valid('param').id, actor = c.get('user'), now = nowIso(), messageId = uuid();
    const current = await detail(c,id);
    if (current.status === 'closed') throw conflict('工单已关闭，请等待管理员重新打开或提交新工单', null);
    await rateLimit(c.env, `ticket-reply:${actor.id}`, 20, 60);
    const notices = await ticketNotificationStatements(c.env,id,actor.id,`ticket-reply:${messageId}`,'ticket_reply',messageId);
    const results = await c.env.DB.batch([
      c.env.DB.prepare(`INSERT INTO support_ticket_messages (id,ticket_id,author_id,is_staff,body,created_at)
        SELECT ?2,id,?1,CASE WHEN ${actorStaff} THEN 1 ELSE 0 END,?3,?4 FROM support_tickets
        WHERE id=?5 AND status<>'closed' AND ${visible} AND ${actorActive}`)
        .bind(actor.id,messageId,c.req.valid('json').body,now,id),
      c.env.DB.prepare(`UPDATE support_tickets SET updated_at=?1 WHERE id=?2 AND EXISTS (SELECT 1 FROM support_ticket_messages WHERE id=?3)`).bind(now,id,messageId),
      ...notices,
    ]);
    if (results[0]!.meta.changes !== 1) throw conflict('工单状态或权限已变化，请刷新后重试', null);
    c.executionCtx.waitUntil(cronTick(c.env,nowIso(),sendWebPush,{ticketsOnly:true}));
    return c.json(await detail(c,id), 200);
  });
  app.openapi(createRoute({ method: 'patch', path: '/tickets/{id}/status', tags: ['tickets'], middleware: [...middleware],
    request: { params: Params, body: { required: true, content: { 'application/json': { schema: z.object({ status: Status }).strict() } } } },
    responses: { 200: { content: { 'application/json': { schema: Detail } }, description: '管理员更新工单状态' }, ...errors },
  }), async c => {
    const actor = c.get('user'), id = c.req.valid('param').id;
    if (!isStaff(actor.role)) throw forbidden('只有管理员可以变更工单状态');
    await detail(c,id);
    await rateLimit(c.env, `ticket-status:${actor.id}`, 30, 60);
    const messageId = uuid(), now = nowIso();
    const notices = await ticketNotificationStatements(c.env,id,actor.id,`ticket-status:${messageId}`,'ticket_status',messageId);
    const results = await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE support_tickets SET status=?3,updated_at=?4 WHERE id=?2 AND ${actorStaff}`)
        .bind(actor.id,id,c.req.valid('json').status,now),
      c.env.DB.prepare(`INSERT INTO support_ticket_messages(id,ticket_id,author_id,is_staff,body,created_at) SELECT ?1,?2,?3,1,'工单状态已更新。',?4 WHERE changes()=1`).bind(messageId,id,actor.id,now),
      ...notices,
    ]);
    if (results[0]!.meta.changes !== 1) throw forbidden('权限已变化，请刷新后重试');
    c.executionCtx.waitUntil(cronTick(c.env,nowIso(),sendWebPush,{ticketsOnly:true}));
    return c.json(await detail(c,id), 200);
  });
}
