import { describe, expect, it, vi } from 'vitest';
import { pbkdf2Sync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { getMf, STUDENT } from './helpers';
import { hashPassword, verifyPassword } from '../src/infra/password';
// @ts-expect-error Reviewed operator-only ESM utility has no declaration file.
import { TARGET, assertTarget, buildResetSql, buildUpgradeSql, decryptDpapi, parseWranglerJson } from '../scripts/recover-greenbp.mjs';

const fixturePassword = 'Fixture-v1-Abcdef-123!';
const fixtureSalt = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
function bootstrapVector(iterations = 600000) {
  return `pbkdf2-sha256$${iterations}$${fixtureSalt.toString('base64url')}$${Buffer.from(pbkdf2Sync(fixturePassword, fixtureSalt, iterations, 32, 'sha256')).toString('base64url')}`;
}
const row = { id: TARGET.userId, username: 'greenbp', role: 'admin', deleted: 0, is_demo: 0, canonical_count: 1, updated_at: '2026-09-01T00:00:00.000Z' };
describe('operator recovery and bootstrap compatibility (synthetic local fixtures)', () => {
  it('verifies the prepare-admin Node PBKDF2 format using the actual Worker verifier', async () => {
    expect(await verifyPassword(fixturePassword, bootstrapVector())).toBe(true);
    expect(await verifyPassword(fixturePassword, bootstrapVector(100000))).toBe(true);
    expect(await verifyPassword(' ' + fixturePassword, bootstrapVector())).toBe(false);
    expect(await verifyPassword(fixturePassword + '\r\n', bootstrapVector())).toBe(false);
  });
  it('only changes greenbp auth state, revokes its sessions and preserves account/business identity', async () => {
    const { mf } = await getMf();
    const db = await mf.getD1Database('DB');
    await db.prepare(`INSERT INTO users (id,role,display_name,timezone,username,password_hash,email,is_demo,created_at,updated_at) VALUES (?1,'admin','Historical name','Asia/Shanghai','greenbp',?3,'fixture@example.test',0,?2,?2)`).bind(row.id, row.updated_at, bootstrapVector()).run();
    await db.batch([
      db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?1,?2,?3)').bind('fixture-session-a', row.id, 9999999999),
      db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?1,?2,?3)').bind('fixture-session-b', STUDENT, 9999999999),
    ]);
    const before = await db.prepare('SELECT * FROM users WHERE id=?1').bind(row.id).first();
    const hash = await hashPassword(fixturePassword);
    const timestamp = '2026-09-30T00:00:00.000Z';
    await db.exec(buildUpgradeSql(row, bootstrapVector(), hash, timestamp));
    const after = await db.prepare('SELECT * FROM users WHERE id=?1').bind(row.id).first();
    expect(after).toEqual({ ...before, password_hash: hash, updated_at: timestamp });
    expect((await db.prepare('SELECT count(*) AS total FROM sessions WHERE user_id=?1').bind(row.id).first())!.total).toBe(0);
    expect((await db.prepare('SELECT count(*) AS total FROM sessions WHERE user_id=?1').bind(STUDENT).first())!.total).toBe(1);
    expect((await db.prepare('SELECT count(*) AS total FROM users').first())!.total).toBe(4);
    // Replaying an old reset cannot overwrite a later password or revoke later sessions.
    await db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?1,?2,?3)').bind('fixture-new-session', row.id, 9999999999).run();
    await db.exec(buildResetSql(row, hash, '2026-09-30T00:01:00.000Z'));
    expect((await db.prepare('SELECT updated_at FROM users WHERE id=?1').bind(row.id).first())!.updated_at).toBe(timestamp);
    expect((await db.prepare('SELECT count(*) AS total FROM sessions WHERE user_id=?1').bind(row.id).first())!.total).toBe(1);
  });
  it('refuses changed identity/status and unsafe hash inputs', () => {
    for (const change of [{ id: STUDENT }, { role: 'student' }, { deleted: 1 }, { is_demo: 1 }, { canonical_count: 2 }]) expect(() => assertTarget({ ...row, ...change })).toThrow();
    expect(() => buildResetSql(row, "bad'; DROP TABLE users;--", '2026-09-30T00:00:00.000Z')).toThrow();
  });
  it.skipIf(process.platform !== 'win32')('runs real Windows DPAPI roundtrip with only a synthetic fixture and parses Wrangler JSON', () => {
    const protectedResult = spawnSync('powershell.exe', ['-NoProfile','-NonInteractive','-Command', "[Reflection.Assembly]::LoadWithPartialName('System.Security') | Out-Null; [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd()),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))"], {input:fixturePassword,encoding:'utf8',windowsHide:true});
    expect(protectedResult.status).toBe(0);
    expect(decryptDpapi(protectedResult.stdout.trim())).toBe(fixturePassword);
    expect(parseWranglerJson('[{"success":true,"results":[{"fixture":1}]}]')[0].results[0].fixture).toBe(1);
    expect(()=>parseWranglerJson('')).toThrow();
  });
  it('uses exact original hash guard for same-password upgrade and rejects weak scrypt factors', async () => {
    const hash = await hashPassword(fixturePassword);
    expect(await verifyPassword(fixturePassword,hash)).toBe(true);
    expect(await verifyPassword('wrong',hash)).toBe(false);
    expect(await verifyPassword(fixturePassword,hash.replace('$32768$','$1024$'))).toBe(false);
    expect(buildUpgradeSql(row,bootstrapVector(),hash,'2026-09-30T00:00:00.000Z')).toContain(`password_hash='${bootstrapVector()}'`);
  });
  it('does not translate hosted PBKDF2 runtime errors into wrong-password results', async () => {
    const mock = vi.spyOn(crypto.subtle,'deriveBits').mockRejectedValue(new DOMException('synthetic iteration limit','NotSupportedError'));
    try { await expect(verifyPassword(fixturePassword,bootstrapVector())).rejects.toMatchObject({name:'NotSupportedError'}); }
    finally { mock.mockRestore(); }
  });
  it('plan creates no credential and noninteractive operator mode is blocked before any I/O', () => {
    const plan = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/recover-greenbp.mjs'], { encoding: 'utf8', windowsHide: true });
    expect(plan.status).toBe(0);
    expect(plan.stdout).toContain('Plan only; no credentials generated/read, no network calls');
    const blocked = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/recover-greenbp.mjs', '--reset'], { encoding: 'utf8', windowsHide: true });
    expect(blocked.status).toBe(1);
    expect(blocked.stdout).not.toContain('Sensitive plaintext file');
  });
});
