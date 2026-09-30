import { createRoute, z } from '@hono/zod-openapi';
import type { App } from '../app';
import { allowedOrigins } from '../app';
import { requireAuth, clearSessionCookie } from '../middleware/auth';
import { forbidden, invalidRequest, unauthorized } from '../shared/errors';
import { ErrorBodySchema } from '../shared/schemas/common';
import { hashPassword, verifyPassword } from '../infra/password';
import { rateLimit } from '../infra/rate-limit';
import { nowIso } from '../shared/datetime';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../env';

const accountGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get('user').demo) throw forbidden('演示身份不能修改账户');
  if (c.req.method !== 'GET') {
    const origin = c.req.header('Origin');
    if (!origin || (origin !== new URL(c.req.url).origin && !allowedOrigins(c.env).includes(origin))
      || c.req.header('Sec-Fetch-Site') === 'cross-site') throw forbidden('请从本站账户设置提交');
    if (!/^application\/json(?:;|$)/i.test(c.req.header('Content-Type') ?? '')) throw forbidden('需要 JSON 请求');
  }
  await next();
};
const errors = {
  401: { content: { 'application/json': { schema: ErrorBodySchema } }, description: '会话失效' },
  403: { content: { 'application/json': { schema: ErrorBodySchema } }, description: '禁止修改' },
  422: { content: { 'application/json': { schema: ErrorBodySchema } }, description: '校验失败' },
  429: { content: { 'application/json': { schema: ErrorBodySchema } }, description: '请求过多' },
};
const AccountSchema = z.object({ displayName: z.string(), username: z.string().nullable() }).openapi('AccountSettings');
const nameSchema = z.string().trim().min(1).max(64).regex(/^[^\u0000-\u001f\u007f-\u009f]*$/u, '昵称不能包含控制字符');
export const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(12, '新密码至少 12 位').max(128)
    .regex(/[a-z]/, '需要小写字母').regex(/[A-Z]/, '需要大写字母').regex(/[0-9]/, '需要数字')
    .regex(/[^a-zA-Z0-9\s]/, '需要符号'),
}).strict().refine(v => v.currentPassword !== v.newPassword, { path: ['newPassword'], message: '新密码不能与原密码相同' }).openapi('ChangePassword');

export function registerAccountRoutes(app: App) {
  app.openapi(createRoute({ method: 'get', path: '/session/account', tags: ['session'], middleware: [requireAuth, accountGuard] as const,
    responses: { 200: { content: { 'application/json': { schema: AccountSchema } }, description: '账户设置' }, ...errors },
  }), async c => {
    const row = await c.env.DB.prepare('SELECT display_name, username FROM users WHERE id=?1 AND deleted=0 AND is_demo=0').bind(c.get('user').id).first<{ display_name: string; username: string | null }>();
    if (!row) throw unauthorized();
    return c.json({ displayName: row.display_name, username: row.username }, 200);
  });
  app.openapi(createRoute({ method: 'patch', path: '/session/account', tags: ['session'], middleware: [requireAuth, accountGuard] as const,
    request: { body: { content: { 'application/json': { schema: z.object({ displayName: nameSchema }).strict().openapi('UpdateAccount') } }, required: true } },
    responses: { 204: { description: '昵称已保存' }, ...errors },
  }), async c => {
    await rateLimit(c.env, `account:${c.get('user').id}`, 10);
    await c.env.DB.prepare('UPDATE users SET display_name=?1, updated_at=?2 WHERE id=?3 AND deleted=0 AND is_demo=0')
      .bind(c.req.valid('json').displayName, nowIso(), c.get('user').id).run();
    return c.body(null, 204);
  });
  app.openapi(createRoute({ method: 'post', path: '/session/password', tags: ['session'], middleware: [requireAuth, accountGuard] as const,
    request: { body: { content: { 'application/json': { schema: ChangePasswordSchema } }, required: true } },
    responses: { 204: { description: '密码已修改，所有会话已撤销，请重新登录' }, ...errors },
  }), async c => {
    const id = c.get('user').id;
    await rateLimit(c.env, `password:${id}`, 5, 300);
    const input = c.req.valid('json');
    const row = await c.env.DB.prepare('SELECT password_hash FROM users WHERE id=?1 AND deleted=0 AND is_demo=0').bind(id).first<{ password_hash: string | null }>();
    if (!row?.password_hash || !await verifyPassword(input.currentPassword, row.password_hash))
      throw invalidRequest([{ field: 'currentPassword', issue: '原密码不正确' }]);
    const hash = await hashPassword(input.newPassword);
    // Compare-and-swap plus revocation in one transaction prevents duplicate/stale submissions.
    const results = await c.env.DB.batch([
      c.env.DB.prepare('UPDATE users SET password_hash=?1, updated_at=?2 WHERE id=?3 AND password_hash=?4 AND deleted=0 AND is_demo=0').bind(hash, nowIso(), id, row.password_hash),
      c.env.DB.prepare('DELETE FROM sessions WHERE user_id=?1 AND EXISTS (SELECT 1 FROM users WHERE id=?1 AND password_hash=?2)').bind(id, hash),
    ]);
    if (results[0]!.meta.changes !== 1) throw invalidRequest([{ field: 'currentPassword', issue: '密码已变化，请重新登录后重试' }]);
    await clearSessionCookie(c);
    return c.body(null, 204);
  });
}
