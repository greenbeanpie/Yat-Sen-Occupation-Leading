import { describe, expect, it } from 'vitest';
import { getMf, loginAs, request, seedInvitation, STUDENT } from './helpers';
const headers = { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' };
const password = 'Fixture-Old-Password-123!';
const nextPassword = 'Fixture-New-Password-456!';
const cookieOf = (r: Response) => r.headers.get('set-cookie')!.split(';')[0]!;
async function fixture() {
  const username = 'account_' + crypto.randomUUID().slice(0, 8);
  const r = await request(undefined, '/session/register', { method: 'POST', headers, body: JSON.stringify({ username, password, displayName: '历史昵称', invitationCode: await seedInvitation() }) });
  expect(r.status).toBe(200);
  const body = await r.json<{ user: { id: string } }>();
  return { cookie: cookieOf(r), username, id: body.user.id };
}
const change = (cookie: string, body: unknown, custom = headers) => request(cookie, '/session/password', { method: 'POST', headers: custom, body: JSON.stringify(body) });
describe('account settings', () => {
  it('preserves historical names and changes only the authenticated account nickname', async () => {
    const f = await fixture();
    const second = await fixture();
    expect(await (await request(f.cookie, '/session/account')).json()).toMatchObject({ displayName: '历史昵称', username: f.username });
    expect((await request(f.cookie, '/session/account', { method: 'PATCH', headers, body: JSON.stringify({ displayName: '  新昵称  ' }) })).status).toBe(204);
    expect(await (await request(f.cookie, '/session')).json()).toMatchObject({ user: { displayName: '新昵称' } });
    expect(await (await request(second.cookie, '/session/account')).json()).toMatchObject({ displayName: '历史昵称' });
    for (const displayName of ['  ', 'a'.repeat(65), 'bad\nname']) {
      expect((await request(f.cookie, '/session/account', { method: 'PATCH', headers, body: JSON.stringify({ displayName }) })).status).toBe(422);
    }
    expect((await request(f.cookie, '/session/account', { method: 'PATCH', headers, body: JSON.stringify({ displayName: 'ok', username: 'changed' }) })).status).toBe(422);
  });
  it('rejects unauthenticated/demo requests and CSRF sources', async () => {
    const f = await fixture();
    const demo = await loginAs(STUDENT);
    expect((await request(undefined, '/session/account')).status).toBe(401);
    expect((await change(demo, { currentPassword: password, newPassword: nextPassword })).status).toBe(403);
    for (const origin of ['', 'https://evil.test']) {
      expect((await change(f.cookie, { currentPassword: password, newPassword: nextPassword }, { ...headers, Origin: origin })).status).toBe(403);
    }
    expect((await change(f.cookie, { currentPassword: password, newPassword: nextPassword }, { ...headers, 'Content-Type': 'text/plain' })).status).toBe(403);
  });
  it('wrong original/weak/same passwords leave credentials and sessions unchanged', async () => {
    const f = await fixture();
    for (const input of [{ currentPassword: 'wrong', newPassword: nextPassword }, { currentPassword: password, newPassword: 'short' }, { currentPassword: password, newPassword: 'abcdefghijklmnop' }, { currentPassword: password, newPassword: password }]) {
      expect((await change(f.cookie, input)).status).toBe(422);
    }
    expect((await request(f.cookie, '/session/account')).status).toBe(200);
    expect((await request(undefined, '/session/login', { method: 'POST', headers, body: JSON.stringify({ username: f.username, password }) })).status).toBe(200);
  });
  it('atomically changes hash, rejects duplicates, revokes all sessions and permits only new credentials', async () => {
    const f = await fixture();
    const other = cookieOf(await request(undefined, '/session/login', { method: 'POST', headers, body: JSON.stringify({ username: f.username, password }) }));
    const responses = await Promise.all([change(f.cookie, { currentPassword: password, newPassword: nextPassword }), change(f.cookie, { currentPassword: password, newPassword: nextPassword })]);
    expect(responses.filter(r => r.status === 204)).toHaveLength(1);
    expect([401, 422]).toContain(responses.find(r => r.status !== 204)!.status);
    for (const cookie of [f.cookie, other]) expect((await request(cookie, '/session/account')).status).toBe(401);
    expect((await request(undefined, '/session/login', { method: 'POST', headers, body: JSON.stringify({ username: f.username, password }) })).status).toBe(401);
    expect((await request(undefined, '/session/login', { method: 'POST', headers, body: JSON.stringify({ username: f.username, password: nextPassword }) })).status).toBe(200);
    const { mf } = await getMf();
    const row = await (await mf.getD1Database('DB')).prepare('SELECT password_hash FROM users WHERE id=?1').bind(f.id).first<{ password_hash: string }>();
    expect(row!.password_hash).toMatch(/^pbkdf2-sha256\$600000\$/);
    expect(row!.password_hash).not.toContain(nextPassword);
  });
  it('limits attempts per account even with multiple valid sessions', async () => {
    const f = await fixture();
    for (let i = 0; i < 5; i++) expect((await change(f.cookie, { currentPassword: 'wrong', newPassword: nextPassword })).status).toBe(422);
    const r = await change(f.cookie, { currentPassword: 'wrong', newPassword: nextPassword });
    expect(r.status).toBe(429);
  });
});
