// Prepare a reviewed, local-only bootstrap package. Never connects to Cloudflare.
// The password is encrypted with Windows DPAPI for the current Windows user.
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, '.wrangler/admin-bootstrap');
const sqlPath = resolve(output, 'greenbp.sql');
const credentialPath = resolve(output, 'greenbp.password.dpapi');
if (!process.argv.includes('--prepare')) {
  console.log('Plan only: prepare real administrator greenbp, optional unverified email zgpride87@outlook.com. No database changes. Use --prepare to generate a local Windows-user-encrypted password and SQL package.');
  process.exit(0);
}
if (process.platform !== 'win32') throw new Error('This bootstrap uses Windows DPAPI; run on the authorized Windows workstation.');
if (existsSync(sqlPath) || existsSync(credentialPath)) throw new Error('Bootstrap artifacts already exist; refusing to replace credentials.');
mkdirSync(output, { recursive: true });
const identity = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
const sid = identity.match(/S-1-5-[0-9-]+/)?.[0];
if (!sid) throw new Error('Cannot resolve current Windows user SID; no credentials written.');
execFileSync('icacls.exe', [output, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`], { windowsHide: true, stdio: 'pipe' });
const password = randomBytes(24).toString('base64url');
const salt = randomBytes(16);
const passwordHash = `scrypt$32768$8$3$${salt.toString('base64url')}$${scryptSync(password, salt, 32, {N:32768,r:8,p:3,maxmem:64*1024*1024}).toString('base64url')}`;
// Password goes through stdin, never shell text, process arguments or output.
const encrypted = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "[Reflection.Assembly]::LoadWithPartialName('System.Security') | Out-Null; [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd()), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser))"], { input: password, encoding: 'utf8', windowsHide: true }).trim();
const now = new Date().toISOString(), id = randomUUID();
const sql = `-- Apply only after 0003/0004 migrations and explicit administrator bootstrap approval.
-- Fail on an existing canonical username; never replace an account or its password.
INSERT INTO users (id,role,display_name,timezone,username,password_hash,email,email_verified_at,is_demo,created_at,updated_at)
VALUES ('${id}','admin','greenbp','Asia/Shanghai','greenbp','${passwordHash}','zgpride87@outlook.com',NULL,0,'${now}','${now}');
`;
writeFileSync(credentialPath, encrypted + '\n', { flag: 'wx' });
writeFileSync(sqlPath, sql, { flag: 'wx' });
console.log(`Prepared local SQL: ${sqlPath}\nEncrypted password: ${credentialPath}\nNo production or local database changes; password is not displayed.`);
