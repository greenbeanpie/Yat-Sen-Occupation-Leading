import { createRoute, z } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import { allowedOrigins, type App } from '../app';
import type { AppEnv } from '../env';
import { requireAuth, requireAdmin, requireSuperAdmin } from '../middleware/auth';
import { ErrorBodySchema, UuidSchema } from '../shared/schemas';
import { forbidden, notFound, conflict } from '../shared/errors';
import { nowIso, uuid } from '../shared/datetime';

const Role = z.enum(['student', 'admin', 'super_admin']);
const User = z.object({ id: UuidSchema, username: z.string().nullable(), displayName: z.string(), role: Role, disabled: z.boolean() }).openapi('ManagedUser');
const Settings = z.object({ registrationEnabled: z.boolean() }).strict().openapi('SystemSettings');
const errors = {
  401: { content: { 'application/json': { schema: ErrorBodySchema } }, description: '未登录' },
  403: { content: { 'application/json': { schema: ErrorBodySchema } }, description: '没有权限' },
  404: { content: { 'application/json': { schema: ErrorBodySchema } }, description: '账户不存在' },
  409: { content: { 'application/json': { schema: ErrorBodySchema } }, description: '账户权限已变化或需要保留最后一位超级管理员' },
  422: { content: { 'application/json': { schema: ErrorBodySchema } }, description: '参数错误' },
};
const guard: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.header('Cache-Control', 'no-store');
  if (c.req.method !== 'GET') {
    const origin = c.req.header('Origin');
    if (!origin || (origin !== new URL(c.req.url).origin && !allowedOrigins(c.env).includes(origin)) || c.req.header('Sec-Fetch-Site') === 'cross-site') throw forbidden('请从本站管理中心提交');
    if (!/^application\/json(?:;|$)/i.test(c.req.header('Content-Type') ?? '')) throw forbidden('需要 JSON 请求');
  }
  await next();
};
// Every mutation rechecks the actor inside the same SQL statement. A concurrent
// demotion/disable therefore cannot leave a previously authorized request privileged.
const superActor = `EXISTS (SELECT 1 FROM users actor WHERE actor.id=?1 AND COALESCE(actor.access_role,actor.role)='super_admin' AND actor.is_demo=0 AND actor.deleted=0 AND actor.disabled=0)`;
const activeSupers = `(SELECT count(*) FROM users WHERE COALESCE(access_role,role)='super_admin' AND deleted=0 AND disabled=0 AND is_demo=0 AND username IS NOT NULL AND trim(username)<>'' AND password_hash IS NOT NULL AND password_hash<>'')`;
const adminMiddleware = [requireAuth, requireAdmin, guard] as const;
const superMiddleware = [requireAuth, requireSuperAdmin, guard] as const;

export function registerUserManagementRoutes(app: App): void {
  app.openapi(createRoute({ method: 'get', path: '/admin/users', tags: ['admin'], middleware: [...adminMiddleware],
    responses: { 200: { content: { 'application/json': { schema: z.object({ items: z.array(User) }) } }, description: '普通管理员仅查看一般用户；不返回凭据或私人业务数据' }, ...errors },
  }), async c => {
    const rows = await c.env.DB.prepare(`SELECT id,username,display_name,COALESCE(access_role,role) AS role,disabled FROM users WHERE deleted=0 AND is_demo=0 AND (?1='super_admin' OR COALESCE(access_role,role)='student') ORDER BY display_name,id`).bind(c.get('user').role).all<{ id: string; username: string | null; display_name: string; role: z.infer<typeof Role>; disabled: number }>();
    return c.json({ items: rows.results.map(r => ({ id: r.id, username: r.username, displayName: r.display_name, role: r.role, disabled: r.disabled === 1 })) }, 200);
  });
  app.openapi(createRoute({ method: 'patch', path: '/admin/users/{id}', tags: ['admin'], middleware: [...adminMiddleware],
    request: { params: z.object({ id: UuidSchema }), body: { required: true, content: { 'application/json': { schema: z.object({ displayName: z.string().trim().min(1).max(64).regex(/^[^\u0000-\u001f\u007f-\u009f]*$/u).optional(), disabled: z.boolean().optional() }).strict().refine(v => v.displayName !== undefined || v.disabled !== undefined, '需要修改字段') } } } },
    responses: { 204: { description: '用户已更新' }, ...errors },
  }), async c => {
    const id = c.req.valid('param').id, actor = c.get('user'), input = c.req.valid('json');
    const target = await c.env.DB.prepare('SELECT COALESCE(access_role,role) AS role FROM users WHERE id=?1 AND deleted=0 AND is_demo=0').bind(id).first<{ role: string }>();
    if (!target) throw notFound();
    if (actor.role !== 'super_admin' && target.role !== 'student') throw forbidden('普通管理员只能管理一般用户');
    if (input.disabled && id === actor.id) throw forbidden('不能停用当前账户');
    const results = await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE users SET display_name=COALESCE(?3,display_name),disabled=COALESCE(?4,disabled),updated_at=?5
        WHERE id=?2 AND deleted=0 AND is_demo=0
        AND (${superActor} OR (COALESCE(access_role,role)='student' AND EXISTS (SELECT 1 FROM users actor WHERE actor.id=?1 AND COALESCE(actor.access_role,actor.role)='admin' AND actor.is_demo=0 AND actor.deleted=0 AND actor.disabled=0)))
        AND (COALESCE(access_role,role)<>'super_admin' OR disabled=1 OR COALESCE(?4,disabled)=0 OR ${activeSupers}>1)`)
        .bind(actor.id, id, input.displayName ?? null, input.disabled === undefined ? null : Number(input.disabled), nowIso()),
      c.env.DB.prepare('DELETE FROM sessions WHERE user_id=?1 AND EXISTS (SELECT 1 FROM users WHERE id=?1 AND disabled=1)').bind(id),
    ]);
    if (results[0]!.meta.changes !== 1) throw conflict('操作未生效：权限已变化或必须保留最后一位超级管理员', null);
    return c.body(null, 204);
  });
  app.openapi(createRoute({ method: 'put', path: '/admin/users/{id}/role', tags: ['admin'], middleware: [...superMiddleware],
    request: { params: z.object({ id: UuidSchema }), body: { required: true, content: { 'application/json': { schema: z.object({ role: Role }).strict() } } } },
    responses: { 204: { description: '身份已更新，后续请求立即使用新权限' }, ...errors },
  }), async c => {
    const id = c.req.valid('param').id, role = c.req.valid('json').role;
    if (!await c.env.DB.prepare('SELECT id FROM users WHERE id=?1 AND deleted=0 AND is_demo=0').bind(id).first()) throw notFound();
    const auditId = uuid(), now = nowIso();
    const results = await c.env.DB.batch([
      // Capture the previous role and authorize within the transaction, before the update.
      c.env.DB.prepare(`INSERT INTO account_role_audit (id,actor_id,target_user_id,previous_role,new_role,created_at)
        SELECT ?5,?1,id,COALESCE(access_role,role),?3,?4 FROM users WHERE id=?2 AND deleted=0 AND is_demo=0 AND ${superActor}
        AND (?3='student' OR (username IS NOT NULL AND trim(username)<>'' AND password_hash IS NOT NULL AND password_hash<>''))
        AND (COALESCE(access_role,role)<>'super_admin' OR disabled=1 OR ?3='super_admin' OR ${activeSupers}>1)`)
        .bind(c.get('user').id, id, role, now, auditId),
      c.env.DB.prepare(`UPDATE users SET access_role=?2,role=CASE WHEN ?2='student' THEN 'student' ELSE 'admin' END,updated_at=?3 WHERE id=?1 AND EXISTS (SELECT 1 FROM account_role_audit WHERE id=?4 AND target_user_id=?1)`)
        .bind(id, role, now, auditId),
    ]);
    if (results[1]!.meta.changes !== 1) throw conflict('操作未生效：权限已变化、账户没有登录凭据或必须保留最后一位可登录的超级管理员', null);
    return c.body(null, 204);
  });
  app.openapi(createRoute({ method: 'get', path: '/admin/settings', tags: ['admin'], middleware: [...superMiddleware],
    responses: { 200: { content: { 'application/json': { schema: Settings } }, description: '系统注册设置' }, ...errors },
  }), async c => {
    const row = await c.env.DB.prepare('SELECT registration_enabled FROM system_settings WHERE id=1').first<{ registration_enabled: number }>();
    return c.json({ registrationEnabled: row?.registration_enabled === 1 }, 200);
  });
  app.openapi(createRoute({ method: 'put', path: '/admin/settings', tags: ['admin'], middleware: [...superMiddleware],
    request: { body: { required: true, content: { 'application/json': { schema: Settings } } } },
    responses: { 200: { content: { 'application/json': { schema: Settings } }, description: '系统设置已更新，不改变邀请码权限和有效期' }, ...errors },
  }), async c => {
    const input = c.req.valid('json');
    const result = await c.env.DB.prepare(`UPDATE system_settings SET registration_enabled=?2 WHERE id=1 AND ${superActor}`).bind(c.get('user').id, Number(input.registrationEnabled)).run();
    if (result.meta.changes !== 1) throw forbidden();
    return c.json(input, 200);
  });
}
