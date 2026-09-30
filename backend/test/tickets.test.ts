import { describe, expect, it } from 'vitest';
import { getMf, loginRealAdmin, loginAs, request, STUDENT, ADMIN } from './helpers';
const headers = { 'Content-Type': 'application/json', Origin: 'http://yso.test' };
async function actor(role: 'student' | 'admin' | 'super_admin') {
  const cookie = await loginRealAdmin();
  const session = await (await request(cookie, '/session')).json<{ user: { id: string } }>();
  const db = await (await getMf()).mf.getD1Database('DB');
  await db.prepare('UPDATE users SET access_role=?1 WHERE id=?2').bind(role, session.user.id).run();
  return { cookie, id: session.user.id, db };
}
const create = (cookie: string, body: object = { subject: '需要帮助', body: '请协助查看我的问题' }) => request(cookie, '/tickets', { method: 'POST', headers, body: JSON.stringify(body) });
const reply = (cookie: string, id: string, body = '补充说明') => request(cookie, `/tickets/${id}/messages`, { method: 'POST', headers, body: JSON.stringify({ body }) });
const status = (cookie: string, id: string, value: string) => request(cookie, `/tickets/${id}/status`, { method: 'PATCH', headers, body: JSON.stringify({ status: value }) });
interface Detail { id: string; subject: string; status: string; messages: { id: string; body: string; isStaff: boolean; authorName: string }[]; messagesNextCursor: string | null }

describe('private support tickets', () => {
  it('requires a real authenticated account, rejecting demo and unauthenticated paths', async () => {
    for (const cookie of [undefined, await loginAs(STUDENT), await loginAs(ADMIN)]) {
      expect([401,403]).toContain((await request(cookie, '/tickets')).status);
      expect([401,403]).toContain((await request(cookie, '/tickets', { method: 'POST', headers, body: JSON.stringify({ subject: 'No', body: 'No' }) })).status);
    }
  });
  it('isolates list, detail and replies by owner; ordinary users cannot change any status', async () => {
    const one = await actor('student'), two = await actor('student');
    const created = await create(one.cookie);
    expect(created.status).toBe(201);
    expect(created.headers.get('Cache-Control')).toBe('no-store');
    const ticket = await created.json<Detail>();
    expect(ticket.status).toBe('pending');
    expect(ticket.messages).toHaveLength(1);
    expect(ticket.messages[0]).toMatchObject({ isStaff: false, body: '请协助查看我的问题' });
    expect(await (await request(two.cookie, '/tickets')).json()).toEqual({ items: [], nextCursor: null });
    expect((await request(two.cookie, `/tickets/${ticket.id}`)).status).toBe(404);
    expect((await reply(two.cookie, ticket.id)).status).toBe(404);
    expect((await status(two.cookie, ticket.id, 'closed')).status).toBe(403);
    expect((await status(one.cookie, ticket.id, 'closed')).status).toBe(403);
    const updated = await reply(one.cookie, ticket.id);
    expect(updated.status).toBe(200);
    expect((await updated.json<Detail>()).messages).toHaveLength(2);
    const listing = await (await request(one.cookie, '/tickets')).json<{ items: object[] }>();
    expect(Object.keys(listing.items[0]!).sort()).toEqual(['createdAt','id','status','subject','updatedAt']);
  });
  it('lets both administrator levels reply and set all five statuses, with closed replies blocked', async () => {
    const owner = await actor('student'), admin = await actor('admin'), superAdmin = await actor('super_admin');
    const ticket = await (await create(owner.cookie)).json<Detail>();
    for (const staff of [admin, superAdmin]) {
      expect((await (await request(staff.cookie, '/tickets')).json<{ items: Detail[] }>()).items[0]?.id).toBe(ticket.id);
      const updated = await reply(staff.cookie, ticket.id, '工作人员回复');
      expect(updated.status).toBe(200);
      expect((await updated.json<Detail>()).messages.some(m => m.isStaff)).toBe(true);
    }
    for (const value of ['in_progress','waiting_user','resolved','closed','pending']) {
      const response = await status(admin.cookie, ticket.id, value);
      expect(response.status).toBe(200);
      expect((await response.json<Detail>()).status).toBe(value);
      if (value === 'closed') {
        expect((await reply(owner.cookie, ticket.id)).status).toBe(409);
        expect((await reply(superAdmin.cookie, ticket.id)).status).toBe(409);
      }
    }
    expect((await reply(owner.cookie, ticket.id)).status).toBe(200);
  });
  it('uses current roles after demotion and denies disabled accounts', async () => {
    const owner = await actor('student'), admin = await actor('admin');
    const ticket = await (await create(owner.cookie)).json<Detail>();
    await admin.db.prepare("UPDATE users SET access_role='student' WHERE id=?1").bind(admin.id).run();
    expect(await (await request(admin.cookie, '/tickets')).json()).toEqual({ items: [], nextCursor: null });
    expect((await request(admin.cookie, `/tickets/${ticket.id}`)).status).toBe(404);
    expect((await reply(admin.cookie, ticket.id)).status).toBe(404);
    expect((await status(admin.cookie, ticket.id, 'resolved')).status).toBe(403);
    await owner.db.prepare('UPDATE users SET disabled=1 WHERE id=?1').bind(owner.id).run();
    expect((await request(owner.cookie, '/tickets')).status).toBe(401);
  });
  it('validates body, state, ownership injection, origins and pagination', async () => {
    const owner = await actor('student'), admin = await actor('admin');
    for (const body of [{ subject: '', body: 'x' }, { subject: 'x', body: '' }, { subject: 'x'.repeat(161), body: 'x' }, { subject: 'x', body: 'x'.repeat(5001) }, { subject: 'x', body: 'x', userId: admin.id }, { subject: 'x', body: 'x', status: 'closed' }]) expect((await create(owner.cookie, body)).status).toBe(422);
    const ticket = await (await create(owner.cookie)).json<Detail>();
    expect((await status(admin.cookie, ticket.id, 'invalid')).status).toBe(422);
    expect((await reply(owner.cookie, ticket.id, '\u0000')).status).toBe(422);
    expect((await request(owner.cookie, '/tickets', { method: 'POST', headers: { ...headers, Origin: 'https://evil.test' }, body: JSON.stringify({ subject: 'x', body: 'x' }) })).status).toBe(403);
    for (const query of ['limit=0','limit=101','limit=1.5','cursor=bad','cursor='+encodeURIComponent(btoa('{"time":"bad","id":"bad"}'))]) expect((await request(owner.cookie, '/tickets?'+query)).status).toBe(422);
    expect((await request(owner.cookie, `/tickets/${ticket.id}?before=bad`)).status).toBe(422);
    expect((await request(owner.cookie, '/tickets/not-a-uuid')).status).toBe(422);
  });
  it('paginates tickets and complete message history without exposing other owners', async () => {
    const owner = await actor('student');
    const ids: string[] = [];
    for (let n = 0; n < 3; n++) ids.push((await (await create(owner.cookie, { subject: `工单 ${n}`, body: '最初消息' })).json<Detail>()).id);
    const first = await (await request(owner.cookie, '/tickets?limit=2')).json<{ items: Detail[]; nextCursor: string }>();
    expect(first.items).toHaveLength(2);
    const next = await (await request(owner.cookie, '/tickets?limit=2&cursor='+encodeURIComponent(first.nextCursor))).json<{ items: Detail[]; nextCursor: string | null }>();
    expect(next.items).toHaveLength(1);
    expect(next.nextCursor).toBeNull();
    expect(new Set([...first.items,...next.items].map(t => t.id))).toEqual(new Set(ids));
    const id = ids[0]!;
    await reply(owner.cookie,id,'第二条'); await reply(owner.cookie,id,'第三条');
    const latest = await (await request(owner.cookie, `/tickets/${id}?limit=2`)).json<Detail>();
    expect(latest.messages.map(m => m.body)).toEqual(['第二条','第三条']);
    const older = await (await request(owner.cookie, `/tickets/${id}?limit=2&before=${encodeURIComponent(latest.messagesNextCursor!)}`)).json<Detail>();
    expect(older.messages.map(m => m.body)).toEqual(['最初消息']);
    expect(older.messagesNextCursor).toBeNull();
  });
  it('preserves text as data and limits repeated creation', async () => {
    const owner = await actor('student');
    const html = '<script>alert(1)</script>';
    const ticket = await (await create(owner.cookie, { subject: html, body: html })).json<Detail>();
    expect(ticket.subject).toBe(html); expect(ticket.messages[0]?.body).toBe(html);
    for (let n=0;n<4;n++) expect((await create(owner.cookie)).status).toBe(201);
    expect((await create(owner.cookie)).status).toBe(429);
  });
});
