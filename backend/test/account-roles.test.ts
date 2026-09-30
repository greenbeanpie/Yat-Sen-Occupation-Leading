import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { getMf, loginRealAdmin, loginAs, request, seedInvitation, STUDENT, ADMIN } from './helpers';
const headers = { 'Content-Type': 'application/json', Origin: 'http://yso.test' };
async function account(role: 'student' | 'admin' | 'super_admin') {
  const cookie = await loginRealAdmin();
  const session = await (await request(cookie, '/session')).json<{ user: { id: string } }>();
  const db = await (await getMf()).mf.getD1Database('DB');
  await db.prepare('UPDATE users SET access_role=?1 WHERE id=?2').bind(role, session.user.id).run();
  return { cookie, id: session.user.id, db };
}
const change = (cookie: string, id: string, role: string) => request(cookie, `/admin/users/${id}/role`, { method: 'PUT', headers, body: JSON.stringify({ role }) });
const edit = (cookie: string, id: string, body: object) => request(cookie, `/admin/users/${id}`, { method: 'PATCH', headers, body: JSON.stringify(body) });
describe('three account levels', () => {
  it('blocks unauthenticated, ordinary users and demo administrators', async () => {
    for (const cookie of [undefined, await loginAs(STUDENT), await loginAs(ADMIN)]) for (const path of ['/admin/users', '/admin/settings']) expect([401,403]).toContain((await request(cookie, path)).status);
  });
  it('limits admin management to ordinary-user metadata and preserves business access', async () => {
    const admin = await account('admin'), ordinary = await account('student'), owner = await account('super_admin');
    const listing = await request(admin.cookie, '/admin/users');
    expect(listing.headers.get('Cache-Control')).toBe('no-store');
    const body = await listing.json<{ items: object[] }>();
    expect(body.items).toEqual([expect.objectContaining({ id: ordinary.id, role: 'student', disabled: false })]);
    expect(Object.keys(body.items[0]!).sort()).toEqual(['disabled','displayName','id','role','username']);
    expect((await edit(admin.cookie, ordinary.id, { displayName: 'Updated user' })).status).toBe(204);
    expect((await edit(admin.cookie, owner.id, { displayName: 'Blocked' })).status).toBe(403);
    expect((await edit(admin.cookie, admin.id, { displayName: 'Blocked' })).status).toBe(403);
    expect((await change(admin.cookie, ordinary.id, 'admin')).status).toBe(403);
    expect((await request(admin.cookie, '/admin/settings')).status).toBe(403);
    expect((await request(admin.cookie, '/admin/settings', { method: 'PUT', headers, body: JSON.stringify({ registrationEnabled: false }) })).status).toBe(403);
    expect((await request(admin.cookie, '/admin/jobs')).status).toBe(200);
    expect((await request(owner.cookie, '/admin/jobs')).status).toBe(200);
  });
  it('rejects privilege mass assignment, invalid roles, demo promotion and cross-origin writes', async () => {
    const owner = await account('super_admin'), user = await account('student');
    expect((await edit(owner.cookie, user.id, { displayName: 'X', role: 'super_admin' })).status).toBe(422);
    expect((await edit(owner.cookie, user.id, { password_hash: 'bad' })).status).toBe(422);
    expect((await request(owner.cookie, `/admin/users/${user.id}/role`, { method: 'PUT', headers: { ...headers, Origin: 'https://evil.test' }, body: JSON.stringify({ role: 'admin' }) })).status).toBe(403);
    expect((await change(owner.cookie, user.id, 'root')).status).toBe(422);
    expect((await change(owner.cookie, ADMIN, 'super_admin')).status).toBe(404);
  });
  it('applies role changes to existing sessions without changing credentials', async () => {
    const owner = await account('super_admin'), user = await account('student');
    const before = await owner.db.prepare('SELECT username,password_hash FROM users WHERE id=?1').bind(user.id).first();
    expect((await change(owner.cookie, user.id, 'admin')).status).toBe(204);
    expect((await request(user.cookie, '/admin/jobs')).status).toBe(200);
    expect(await owner.db.prepare('SELECT role,access_role FROM users WHERE id=?1').bind(user.id).first()).toEqual({ role: 'admin', access_role: 'admin' });
    expect((await change(owner.cookie, user.id, 'student')).status).toBe(204);
    expect((await request(user.cookie, '/admin/jobs')).status).toBe(403);
    expect(await owner.db.prepare('SELECT role,access_role FROM users WHERE id=?1').bind(user.id).first()).toEqual({ role: 'student', access_role: 'student' });
    expect(await owner.db.prepare('SELECT username,password_hash FROM users WHERE id=?1').bind(user.id).first()).toEqual(before);
  });
  it('requires usable login credentials for promotions and preserves the only login-capable super admin', async () => {
    const owner = await account('super_admin');
    const unusable = crypto.randomUUID();
    await owner.db.prepare("INSERT INTO users (id,role,access_role,display_name,created_at,updated_at) VALUES (?1,'student',NULL,'No credentials','2026','2026')").bind(unusable).run();
    expect((await change(owner.cookie,unusable,'super_admin')).status).toBe(409);
    await owner.db.prepare("UPDATE users SET access_role='super_admin' WHERE id=?1").bind(unusable).run();
    expect((await change(owner.cookie,owner.id,'admin')).status).toBe(409);
    expect(await owner.db.prepare('SELECT count(*) AS n FROM account_role_audit').first()).toEqual({ n: 0 });
  });
  it('records role changes atomically without credentials', async () => {
    const owner = await account('super_admin'), user = await account('student');
    expect((await change(owner.cookie,user.id,'super_admin')).status).toBe(204);
    expect(await owner.db.prepare('SELECT role,access_role FROM users WHERE id=?1').bind(user.id).first()).toEqual({ role: 'admin', access_role: 'super_admin' });
    const audit = await owner.db.prepare('SELECT actor_id,target_user_id,previous_role,new_role FROM account_role_audit').all();
    expect(audit.results).toEqual([{ actor_id: owner.id, target_user_id: user.id, previous_role: 'student', new_role: 'super_admin' }]);
  });
  it('revokes disabled-user sessions permanently and prevents self-disable', async () => {
    const owner = await account('super_admin'), user = await account('student');
    expect((await edit(owner.cookie, user.id, { disabled: true })).status).toBe(204);
    expect(await (await request(user.cookie, '/session')).json()).toMatchObject({ authenticated: false });
    expect((await edit(owner.cookie, user.id, { disabled: false })).status).toBe(204);
    expect(await (await request(user.cookie, '/session')).json()).toMatchObject({ authenticated: false });
    expect((await edit(owner.cookie, owner.id, { disabled: true })).status).toBe(403);
  });
  it('protects the last active super admin even during concurrent demotions', async () => {
    const one = await account('super_admin');
    expect((await change(one.cookie, one.id, 'admin')).status).toBe(409);
    const two = await account('super_admin');
    const statuses = await Promise.all([change(one.cookie, one.id, 'admin'), change(two.cookie, two.id, 'admin')]);
    expect(statuses.map(r => r.status).sort()).toEqual([204,409]);
    expect(await one.db.prepare("SELECT count(*) AS n FROM users WHERE COALESCE(access_role,role)='super_admin' AND disabled=0 AND deleted=0 AND is_demo=0").first()).toEqual({ n: 1 });
  });
  it('keeps invitation registration ordinary-only and supports a super-only pause', async () => {
    const owner = await account('super_admin'), code = await seedInvitation();
    const setting = (enabled: boolean) => request(owner.cookie, '/admin/settings', { method: 'PUT', headers, body: JSON.stringify({ registrationEnabled: enabled }) });
    expect((await setting(false)).status).toBe(200);
    const input = { invitationCode: code, username: 'invited_user', password: 'test-only-password-A1!', role: 'super_admin' };
    expect((await request(undefined, '/session/register', { method: 'POST', headers, body: JSON.stringify(input) })).status).toBe(403);
    expect((await setting(true)).status).toBe(200);
    const registered = await request(undefined, '/session/register', { method: 'POST', headers, body: JSON.stringify(input) });
    expect(registered.status).toBe(200);
    expect(await registered.json()).toMatchObject({ user: { role: 'student' } });
  });
});
describe('credential-preserving role migration', () => {
  it('promotes only the existing real greenbp admin and preserves every other column and related session', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys=ON');
    for (const file of readdirSync(resolve('migrations')).filter(f => f.endsWith('.sql') && f < '0005').sort()) db.exec(readFileSync(resolve('migrations', file), 'utf8'));
    db.exec("INSERT INTO users (id,role,display_name,username,password_hash,email,is_demo,created_at,updated_at) VALUES ('b3c4dacf-3562-4938-8ba7-d102f4cffe05','admin','Owner','greenbp','scrypt:original-salt:original-hash','test@example.invalid',0,'old','old'),('other','admin','Other','another_admin','untouched',NULL,0,'old','old'),('demo','admin','Demo',NULL,NULL,NULL,1,'old','old'); INSERT INTO sessions (id,user_id,expires_at) VALUES ('existing-session','b3c4dacf-3562-4938-8ba7-d102f4cffe05',9999999999)");
    db.exec("CREATE TABLE preservation_probe (user_id TEXT REFERENCES users(id) ON DELETE CASCADE); INSERT INTO preservation_probe (user_id) VALUES ('b3c4dacf-3562-4938-8ba7-d102f4cffe05')");
    const before = db.prepare('SELECT * FROM users ORDER BY id').all();
    db.exec(readFileSync(resolve('migrations/0005_account_roles.sql'), 'utf8'));
    expect(db.prepare('SELECT * FROM users ORDER BY id').all()).toEqual(before.map(row => ({ ...row, access_role: row.id === 'b3c4dacf-3562-4938-8ba7-d102f4cffe05' ? 'super_admin' : null, disabled: 0 })));
    expect(db.prepare('SELECT user_id FROM sessions').get()).toEqual({ user_id: 'b3c4dacf-3562-4938-8ba7-d102f4cffe05' });
    expect(db.prepare('SELECT count(*) AS n FROM preservation_probe').get()).toEqual({ n: 1 });
    db.close();
  });
});
