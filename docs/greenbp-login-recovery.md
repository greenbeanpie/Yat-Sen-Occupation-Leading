# greenbp login diagnosis and operator recovery

## KDF compatibility fix and user command

Project 2's same-account production record confirms PBKDF2 600000 failed with NotSupportedError while local tests passed. This fix uses the production-validated native scrypt parameters N=32768/r=8/p=3, 16-byte random salt, 32-byte output, 64 MiB max allocation. Storage uses unpadded Base64URL. Existing PBKDF2 formats remain recognized and upgrade after successful verification where the runtime supports them; unsupported runtime operations propagate as service errors rather than incorrect-password results. New registration, password change and bootstrap use scrypt. No schema migration is required.

The failed first comparison was a utility bug: WRANGLER_LOG=error suppresses --json output. The utility now uses info logging while capturing all child output and disabling disk logs. Errors report only the safe operation stage and whether a write was attempted. A compare failure never claims APPLY occurred. Real Windows DPAPI roundtrip is tested with a synthetic password.

After the compatible backend deployment is confirmed, the user runs:

```powershell
Set-Location 'C:\Users\hmz\Documents\SYSU-data\Yat-Sen-Occupation-Leading\backend'
node --import tsx scripts/recover-greenbp.mjs --upgrade-kdf
```

Confirm `UPGRADE greenbp`, check boolean comparison, then `APPLY UPGRADE greenbp`. A mismatch refuses the upgrade. The same password is retained; no plaintext file is created by upgrade. Sensitive SQL is confined to the ignored, Windows-user-only recovery directory. Both session deletion and password update require the reviewed exact user ID, original hash, unchanged updated_at and unchanged admin/non-demo identity. There is no automatic write retry. A failed/uncertain submit requires metadata review. The user logs in manually and deletes that run's sensitive SQL directory after success. `--compare` remains read-only; `--reset` is only for a user-confirmed mismatch and uses scrypt now.

The earlier diagnostic notes below describe the deployed pre-fix state; local Node comparison alone does not establish hosted PBKDF2 support.

Release validation: runtime commit `e6b0a49316506aad1a83c76677b5b447aee0d6e1` was pushed with all already-merged UI commits preserved. CI run [36755247181](https://github.com/greenbeanpie/Yat-Sen-Occupation-Leading/actions/runs/36755247181) completed successfully. Local backend typecheck and 116 tests passed; full preflight passed 15/15. Only the existing backend was deployed, version `10d2093d-2591-4a19-8a5e-77a1e0ba976e`; frontend/UI deployment was not performed. Backend and same-origin frontend API smoke passed 14/14 each. A synthetic nonexistent account request exercised native scrypt and returned expected 401 without a session cookie. No real credential was decrypted, compared or changed by the agent; final operator upgrade/login remains pending. No schema migration, new resources or secrets were needed.

This utility does not fix an established application bug. The user reports the application's username/password error after entering username `greenbp`; a Cloudflare challenge is not assumed to explain that error. No real password, DPAPI plaintext, bootstrap SQL or production salt/digest was read by the agent. No real-credential login, password generation, reset or deployment was performed for this diagnosis.

Read-only findings on 2026-09-30:

- Production backend version is `df0ce78b-b946-4d1a-9731-a238a644373d`, frontend `ef433b5d-c0c7-45d3-8875-5d8e9445c7a1`. Local main `cee59dc` contains additional UI changes, not yet deployed; this task preserves them in a separate worktree.
- The same-origin workers.dev session endpoint and backend session endpoint return 200. Automated custom-domain requests receive the pre-existing Cloudflare challenge; this is distinct from the user-observed credential error.
- D1 account `17a6817bca6612a9cb11d0395eeba0ac`, `yso-db` ID `a3a5c86a-d7f7-46f7-b1d1-9440f6ec9322`: exactly one active non-demo real account. `greenbp` ID `b3c4dacf-3562-4938-8ba7-d102f4cffe05` is an active real administrator with a stored credential, no active sessions, and expected format metadata: `pbkdf2-sha256`, 600000 iterations, three separators, 22-character salt encoding and 43-character digest encoding. Only lengths/public algorithm fields were returned, not salt/digest values.
- `prepare-admin.mjs` and the current Worker verifier use compatible 16-byte salts, 32-byte PBKDF2-SHA256 keys and unpadded Base64URL. A fixed synthetic Node bootstrap vector is tested against the actual Worker verifier. Leading/trailing password whitespace is intentionally significant; usernames are trimmed and case-normalized.
- Login posts JSON `{username,password}` to `/api/v1/session/login`. Email is not a login identifier. Cookies are Secure/HttpOnly/SameSite=Lax, host-only, with `credentials: include`; the frontend forwards requests unchanged to `greenbp-intern-workbench-backend`. A credential 401 occurs before cookie issuance, unlike a later session/cookie failure. Username rate limiting yields 429 and Retry-After, not a credential 401.

Remote schema inspection matched all 30 business tables and 25 explicit indexes against migrations 0001–0004, including column definitions, index definitions and foreign keys. Migration records contain all four files. No database reset is indicated. The backend secret names are SESSION_SECRET, VAPID_PRIVATE_KEY and VAPID_SUBJECT; no mail provider, sender or email binding is configured.

**Hosted-runtime compatibility remains unverified.** Cloudflare maintainers confirm that local workerd removed its default PBKDF2 iteration limit while hosted production retained a limit; the issue remains open with recent reports: https://github.com/cloudflare/workerd/issues/1346#issuecomment-1874827249. Current verification catches all WebCrypto errors and returns false, so an iteration-limit exception can masquerade as an incorrect password. A local fixed-vector success does not prove production compatibility. Do not execute a reset until this possibility is resolved: a newly generated 600000-iteration hash could fail identically. Merely lowering new-hash iterations or replacing WebCrypto with node:crypto cannot validate an existing 600000-iteration hash.

The remaining uncertainties include hosted-runtime support, whether the operator's original DPAPI file matches the current D1 credential, and whether the submitted text was identical. Do not share passwords, hashes, bootstrap SQL or screenshots of those values.

## First: boolean-only comparison, run by the user

From this worktree's `backend` directory, in an interactive Windows terminal:

```powershell
node --import tsx scripts/recover-greenbp.mjs --compare
```

Type `COMPARE greenbp` when prompted. The utility reads the original DPAPI file from the main checkout's ignored `backend/.wrangler/admin-bootstrap/greenbp.password.dpapi`, decrypts only in the operator's process, compares against the current D1 hash using the actual verifier, and emits only three booleans: `matchesProduction`, `hasOuterWhitespace`, `withinLoginLength`. It does not send a login request. Wrangler output is captured and disk logging disabled; secret data is never printed.

If `matchesProduction` is true, the original file matches the stored credential under Node, but the hosted runtime may still reject the KDF. Avoid resetting just to investigate. If false, the original file does not match the current credential under Node. Comparison cannot prove hosted-runtime compatibility or what text a previous form submission contained.

## User-executed scoped reset

Prepared for later use only; currently paused pending hosted-runtime diagnosis.

```powershell
node --import tsx scripts/recover-greenbp.mjs --reset
```

The script shows the exact reviewed account/D1 target and requires `RESET greenbp yso-db` before generating anything. It then generates a strong random temporary password, hashes it with the actual current implementation, and writes a **sensitive plaintext** file and scoped SQL under the main checkout's gitignored `backend/.wrangler/account-recovery/<unique-run>/`. The new folder permits only the current Windows user. The password file contains exactly one password, with no BOM/newline/label; do not commit, share or paste it into chat.

A second confirmation, `APPLY greenbp`, is required before the script submits the SQL using the existing authenticated Wrangler connection. Cancelling here leaves local files but does not change production; the locally generated password is not active. The reviewed Cloudflare account and exact D1 ID are pinned; the script refuses absent/replaced/demo/deleted accounts and never creates an account. It rechecks account metadata immediately before the write and uses an `updated_at` guard to reject stale changes.

The small SQL import deletes only this account's sessions and updates only `password_hash` and `updated_at`. ID, username, role, nickname, email and associated business tables are preserved. The script verifies the resulting hash and zero sessions internally, without an HTTP credential login or sensitive output. If submission/verification fails, it stops and does not retry automatically; the operator should keep the restricted local files and request a metadata review.

After confirmed success, **the user** opens the plaintext file locally and logs in manually at `https://greenbp-intern-workbench.hddhp.workers.dev` as `greenbp`. After access is restored, the user changes the temporary password in Account Settings, then removes that run's recovery folder. Browser/password input and final cloud submission are deliberately left to the user. Default invocation (without flags) is plan-only; operator modes refuse noninteractive/agent execution.
