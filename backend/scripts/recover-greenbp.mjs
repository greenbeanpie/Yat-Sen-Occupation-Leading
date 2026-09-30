// Operator-only recovery. Default is a plan; automation must never use --compare/--reset.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { hashPassword, verifyPassword } from '../src/infra/password.ts';

export const TARGET = Object.freeze({
  accountId: '17a6817bca6612a9cb11d0395eeba0ac',
  databaseId: 'a3a5c86a-d7f7-46f7-b1d1-9440f6ec9322', databaseName: 'yso-db',
  userId: 'b3c4dacf-3562-4938-8ba7-d102f4cffe05', username: 'greenbp',
  frontend: 'https://greenbp-intern-workbench.hddhp.workers.dev',
});
const backend = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let stage = 'arguments';
let writeAttempted = false;
const quote = value => "'" + String(value).replaceAll("'", "''") + "'";
export function assertTarget(row) {
  if (!row || row.id !== TARGET.userId || row.username.trim().toLowerCase() !== TARGET.username
    || row.role !== 'admin' || Number(row.deleted) !== 0 || Number(row.is_demo) !== 0
    || Number(row.canonical_count) !== 1 || typeof row.updated_at !== 'string') {
    throw new Error('Target identity/state differs from the reviewed greenbp account; stopped.');
  }
}
export function buildResetSql(row, hash, timestamp) {
  assertTarget(row);
  if (!/^scrypt\$32768\$8\$3\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/.test(hash)) throw new Error('Invalid recovery hash format.');
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(timestamp) || timestamp === row.updated_at) throw new Error('Invalid recovery timestamp.');
  const condition = `id=${quote(TARGET.userId)} AND lower(trim(username))='greenbp' AND role='admin' AND deleted=0 AND is_demo=0 AND updated_at=${quote(row.updated_at)} AND (SELECT count(*) FROM users WHERE lower(trim(username))='greenbp')=1`;
  // Small D1 SQL import: revoke sessions and update only auth state, with the same identity/CAS guard.
  // No CREATE/INSERT/REPLACE/DROP, no username/role/email/id/business-data mutation.
  return `DELETE FROM sessions WHERE user_id=${quote(TARGET.userId)} AND EXISTS (SELECT 1 FROM users WHERE ${condition});\nUPDATE users SET password_hash=${quote(hash)}, updated_at=${quote(timestamp)} WHERE ${condition};\n`;
}
function cli(args) {
  const r = spawnSync(process.execPath, [resolve(backend, 'node_modules/wrangler/bin/wrangler.js'), ...args], {
    cwd: backend, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: TARGET.accountId,
      WRANGLER_WRITE_LOGS: 'false', WRANGLER_LOG_SANITIZE: 'true', WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG: 'log' },
  });
  // Never forward Wrangler output/errors: a credential query or SQL error may contain a hash.
  if (r.error || r.status !== 0) {
    const output = (r.stderr ?? '') + (r.stdout ?? '');
    const code = r.error ? 'PROCESS_START_FAILED' : /authenticate|authentication|expired|login|10000/i.test(output) ? 'CLOUD_AUTH_FAILED' : /fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|proxy/i.test(output) ? 'CLOUD_NETWORK_FAILED' : 'CLOUD_COMMAND_FAILED';
    throw Object.assign(new Error('Cloudflare command failed; sensitive output suppressed.'), {safeCode:code});
  }
  return parseWranglerJson(r.stdout);
}
export function parseWranglerJson(stdout) {
  const start = stdout.indexOf('[');
  let payload;
  try { payload = JSON.parse(stdout.slice(start)); } catch { throw Object.assign(new Error('Unexpected Cloudflare response; sensitive output suppressed.'),{safeCode:stdout.trim() ? 'CLOUD_JSON_INVALID' : 'CLOUD_JSON_MISSING'}); }
  if (!Array.isArray(payload) || payload.some(item => item.success !== true || item.error)) throw new Error('Cloudflare did not confirm success; stopped.');
  return payload;
}
function query(sql) {
  return cli(['d1', 'execute', TARGET.databaseId, '--config', resolve(backend, 'wrangler.jsonc'), '--remote', '--command', sql, '--json']).flatMap(item => item.results ?? []);
}
function targetMetadata() {
  const rows = query(`SELECT id,username,role,deleted,is_demo,updated_at,(SELECT count(*) FROM users WHERE lower(trim(username))='greenbp') AS canonical_count FROM users WHERE lower(trim(username))='greenbp'`);
  if (rows.length !== 1) throw new Error('Expected exactly one existing greenbp account; stopped without creating an account.');
  assertTarget(rows[0]);
  return rows[0];
}
function mainRoot() {
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: backend, encoding: 'utf8', windowsHide: true }).trim();
  return dirname(common);
}
function privateOutputDirectory() {
  const directory = resolve(mainRoot(), 'backend/.wrangler/account-recovery', new Date().toISOString().replaceAll(':', '-') + '-' + randomUUID());
  const ignore = spawnSync('git', ['check-ignore', '--no-index', directory + '/greenbp.temporary-password.txt'], { cwd: mainRoot(), stdio: 'pipe', windowsHide: true });
  if (ignore.status !== 0) throw new Error('Sensitive output path is not gitignored; stopped.');
  mkdirSync(directory, { recursive: true });
  const identity = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
  const sid = identity.match(/S-1-5-[0-9-]+/)?.[0];
  if (!sid) throw new Error('Cannot determine current Windows identity; stopped before generating a credential.');
  execFileSync('icacls.exe', [directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`], { stdio: 'pipe', windowsHide: true });
  return directory;
}
async function compare() {
  stage = 'cloud-metadata';
  const row = targetMetadata();
  stage = 'dpapi-file';
  const encryptedPath = resolve(mainRoot(), 'backend/.wrangler/admin-bootstrap/greenbp.password.dpapi');
  if (!existsSync(encryptedPath)) throw new Error('Original DPAPI file not found. No credential was read or changed.');
  const encrypted = readFileSync(encryptedPath, 'utf8').trim();
  stage = 'dpapi-decrypt';
  const decrypted = decryptDpapi(encrypted);
  stage = 'cloud-credential-read';
  const stored = query(`SELECT password_hash FROM users WHERE id=${quote(row.id)} AND deleted=0 AND is_demo=0`)[0]?.password_hash;
  if (typeof stored !== 'string') throw new Error('No stored credential available for comparison.');
  stage = 'local-kdf-compare';
  const matches = await verifyPassword(decrypted, stored);
  console.log(JSON.stringify({ matchesProduction: matches,
    hasOuterWhitespace: decrypted !== decrypted.trim(), withinLoginLength: decrypted.length >= 1 && decrypted.length <= 128 }));
  return { row, password: decrypted, stored, matches };
}
export function decryptDpapi(encrypted) {
  const decrypted = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "[Reflection.Assembly]::LoadWithPartialName('System.Security') | Out-Null; $encoded=[Console]::In.ReadToEnd().Trim(); $plain=[Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($encoded),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))"],
  { input: encrypted, encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  return decrypted;
}
export function buildUpgradeSql(row, oldHash, newHash, timestamp) {
  if (!/^(?:pbkdf2-sha256\$(?:100000|600000)|scrypt\$32768\$8\$3)\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/.test(oldHash)) throw new Error('Unsupported old hash.');
  return buildResetSql(row, newHash, timestamp).replaceAll(`id=${quote(TARGET.userId)} AND lower`, `id=${quote(TARGET.userId)} AND password_hash=${quote(oldHash)} AND lower`);
}
async function upgrade(terminal) {
  if ((await terminal.question('Compare original DPAPI locally and prepare same-password scrypt upgrade? Type UPGRADE greenbp: ')).trim() !== 'UPGRADE greenbp') { console.log('Cancelled; no changes.'); return; }
  const { row, password, stored, matches } = await compare();
  if (!matches) { console.log('Original password does not match. Upgrade refused; no write.'); return; }
  if (stored.startsWith('scrypt$')) { console.log('Already using scrypt; no write needed.'); return; }
  stage = 'local-scrypt';
  const hash = await hashPassword(password);
  if (!await verifyPassword(password, hash)) throw new Error('Local scrypt self-check failed.');
  const timestamp = new Date().toISOString();
  stage = 'private-sql-file';
  const output = privateOutputDirectory();
  const sqlPath = resolve(output, 'greenbp.upgrade.sql');
  writeFileSync(sqlPath, buildUpgradeSql(row, stored, hash, timestamp), {encoding:'utf8',flag:'wx'});
  console.log(`Target: greenbp / ${TARGET.databaseId}. Same password; only authentication fields and sessions. Sensitive SQL remains gitignored; no plaintext password file created.`);
  if ((await terminal.question('Ensure scrypt backend has been deployed. Type APPLY UPGRADE greenbp to submit once: ')).trim() !== 'APPLY UPGRADE greenbp') { console.log('Cancelled; production unchanged.'); return; }
  stage = 'cloud-upgrade-submit';
  writeAttempted = true;
  cli(['d1','execute',TARGET.databaseId,'--config',resolve(backend,'wrangler.jsonc'),'--remote','--file',sqlPath,'--json','--yes']);
  stage = 'cloud-upgrade-verify';
  const check = query(`SELECT password_hash,updated_at,(SELECT count(*) FROM sessions WHERE user_id=${quote(row.id)}) AS session_count FROM users WHERE id=${quote(row.id)}`)[0];
  if (check?.password_hash !== hash || check?.updated_at !== timestamp || Number(check?.session_count) !== 0) throw new Error('Guarded upgrade not confirmed.');
  console.log('Upgrade verified. Password unchanged, sessions revoked. Log in manually; remove the sensitive upgrade SQL folder after verification.');
}
async function reset(terminal) {
  stage = 'cloud-metadata';
  const row = targetMetadata();
  console.log(`Target: ${TARGET.username} (${row.id}), existing admin in ${TARGET.databaseName} (${TARGET.databaseId}), Cloudflare account ${TARGET.accountId}.\nOnly password_hash/updated_at and this account's sessions will change. No account replacement. A sensitive plaintext file will be written in a gitignored, Windows-user-only directory.`);
  if ((await terminal.question('Type RESET greenbp yso-db to generate local recovery files: ')).trim() !== 'RESET greenbp yso-db') { console.log('Cancelled; no credential generated and no remote changes.'); return; }
  stage = 'private-reset-files';
  const output = privateOutputDirectory();
  const password = randomBytes(24).toString('base64url') + 'aA1!';
  const hash = await hashPassword(password);
  if (!await verifyPassword(password, hash)) throw new Error('Local hash self-check failed before any remote write.');
  const timestamp = new Date().toISOString();
  const passwordPath = resolve(output, 'greenbp.temporary-password.txt');
  const sqlPath = resolve(output, 'greenbp.reset.sql');
  writeFileSync(passwordPath, password, { encoding: 'utf8', flag: 'wx' }); // no BOM, label, whitespace or newline
  writeFileSync(sqlPath, buildResetSql(row, hash, timestamp), { encoding: 'utf8', flag: 'wx' });
  console.log(`Sensitive plaintext file (do not share/commit): ${passwordPath}\nPrepared scoped SQL: ${sqlPath}\nNothing has been uploaded. Do not treat this local password as active yet.`);
  if ((await terminal.question('Type APPLY greenbp to submit this scoped reset and revoke sessions: ')).trim() !== 'APPLY greenbp') { console.log('Cancelled; local files remain but the production password is unchanged.'); return; }
  const fresh = targetMetadata();
  if (fresh.updated_at !== row.updated_at) throw new Error('Account changed after review; no reset submitted.');
  stage = 'cloud-reset-submit'; writeAttempted = true;
  cli(['d1', 'execute', TARGET.databaseId, '--config', resolve(backend, 'wrangler.jsonc'), '--remote', '--file', sqlPath, '--json', '--yes']);
  // Retrieve the new stored hash only inside the operator's process, never print it.
  const check = query(`SELECT id,username,role,deleted,is_demo,updated_at,password_hash,(SELECT count(*) FROM users WHERE lower(trim(username))='greenbp') AS canonical_count,(SELECT count(*) FROM sessions WHERE user_id=${quote(TARGET.userId)}) AS session_count FROM users WHERE id=${quote(TARGET.userId)}`)[0];
  assertTarget(check);
  if (check.updated_at !== timestamp || check.password_hash !== hash || Number(check.session_count) !== 0) throw new Error('Reset verification incomplete. Do not retry automatically; keep local files and request a metadata review.');
  console.log(`Reset verified; account identity preserved and all sessions revoked. Login yourself as greenbp at ${TARGET.frontend} using the sensitive local file. After login, change the temporary password yourself in Account Settings and remove the recovery folder.`);
}
async function main() {
  const flags = process.argv.slice(2);
  if (flags.length === 1 && flags[0] === '--diagnose') {
    stage = 'cloud-read-diagnostic';
    const result = query('SELECT 1 AS fixture');
    if (result[0]?.fixture !== 1) throw new Error('Unexpected safe diagnostic result.');
    console.log(JSON.stringify({cloudRead:true,jsonParsed:true,credentialRead:false,credentialWrite:false}));
    return;
  }
  if (flags.length === 0 || (flags.length === 1 && flags[0] === '--help')) {
    console.log(`Plan only; no credentials generated/read, no network calls, no database changes.\nTarget: greenbp / yso-db (${TARGET.databaseId}), Cloudflare account ${TARGET.accountId}.\nOperator in a Windows terminal: node --import tsx scripts/recover-greenbp.mjs --compare, --upgrade-kdf (same password; after backend deploy), or --reset (user-confirmed mismatch). Never run these operator modes via an agent.`);
    return;
  }
  if (flags.length !== 1 || !['--compare', '--reset', '--upgrade-kdf'].includes(flags[0])) throw new Error('Unsupported mode.');
  if (process.platform !== 'win32' || !process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Operator modes require the user to run this directly in an interactive Windows terminal. No credential or database operation performed.');
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (flags[0] === '--compare') {
      if ((await terminal.question('Read the original DPAPI password and compare to current D1 locally without logging in? Type COMPARE greenbp: ')).trim() !== 'COMPARE greenbp') { console.log('Cancelled.'); return; }
      await compare();
    } else if (flags[0] === '--upgrade-kdf') await upgrade(terminal);
    else await reset(terminal);
  } finally { terminal.close(); }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(`Recovery stopped at ${stage} (${error?.safeCode ?? 'STAGE_FAILED'}). Sensitive details suppressed. ${writeAttempted ? 'A credential write was attempted; do not retry. Request metadata review.' : 'No credential write was attempted.'}`); process.exitCode = 1; });
}
