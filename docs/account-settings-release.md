# Account settings and approved release

Implemented in an isolated Git worktree from `67f4794`, then integrated with the theme change `c4cb9b4` before merging into main. No database migration is required. Existing usernames, optional unverified emails, historical display names, invitations, production passwords and secrets are preserved.

- Settings contains nickname editing (trimmed, 1–64 characters, no control characters), a read-only username and password change. Demo/guest identities cannot modify account settings.
- Password changes require the original password and a different 12–128 character new password containing uppercase/lowercase letters, a digit and a symbol. Existing login/registration credential policy remains compatible.
- Uses the existing salted PBKDF2-SHA256 600,000 iteration hash. Origin/JSON checks, SameSite cookies and a D1 account limit of five password attempts per five minutes protect changes.
- A transactional compare-and-swap updates the password and revokes **all** sessions, including the submitting device. The browser clears password fields and its cached session, then asks for a new login. Duplicate/concurrent changes cannot both succeed. Credential login checks the verified hash again when creating a session to avoid issuing a session from a stale password.
- Account writes use direct online requests, never the offline queue. No email reassignment, username change, account deletion or password reset was added.

Local checks: backend typecheck and 109 tests; frontend typecheck, lint, 42 tests after theme integration, build; OpenAPI snapshot/type regeneration; full preflight 15/15. Browser fixtures cover nickname save/cancel, password cancel, wrong original password, duplicate submit, successful logout, expired session and demo guard. Theme browser acceptance passes eight groups. Browser screenshots are ignored artifacts under `frontend/e2e/.artifacts/`.

The user subsequently approved pushing main, updating the existing backend/frontend Workers and enabling the existing frontend `workers.dev` entry. Frontend custom domain and Service Binding are retained. The exact workers.dev frontend origin is added to the backend CORS allowlist. This entry shares production D1/R2 and keeps authentication/authorization; no WAF/challenge policy is changed. Real user password changes must be performed by the user; automated password tests use local synthetic fixtures only.

Production acceptance found that asset-first routing bypassed security headers in the frontend Worker handler. `public/_headers` applies the same existing CSP, nosniff, referrer and HSTS policies to static assets. Preview URLs are explicitly disabled to limit public entry points to the approved workers.dev route and existing custom domain.

## Completed release — 2026-09-30

- Runtime release commit: `d84ebb93f36ac67265fdc84fcb14ef1e9ca3286a`, merged into main and pushed to origin. Account implementation is `b511798`; theme integration is `1e672e4`. No UI audit work was included.
- [Final runtime CI](https://github.com/greenbeanpie/Yat-Sen-Occupation-Leading/actions/runs/36748486437): completed/success for backend, frontend and OpenAPI contract jobs. Main-directory final preflight passed 15/15.
- Existing backend `greenbp-intern-workbench-backend`: deployed first, version `df0ce78b-b946-4d1a-9731-a238a644373d` (account code from `aae0c32`; later fixes affect only frontend static routing/headers). Existing frontend `greenbp-intern-workbench`: final version `ef433b5d-c0c7-45d3-8875-5d8e9445c7a1` from `d84ebb9`.
- [Frontend entry](https://greenbp-intern-workbench.hddhp.workers.dev): HTTP 200, no challenge at verification time; SPA routes, assets, CSP/theme initializer and same-origin API verified. Version preview URL returned 404 with `preview_urls: false`.
- Required smoke script passed 14/14 against both backend URL and frontend same-origin entry. Anonymous account, password, profile and admin access returned 401. Public demo account/password access returned 403; its temporary verification session was logged out. The workers.dev CORS origin was confirmed.
- Production Chrome verified system-dark initial theme, persisted light theme after reload, same-origin session requests and no JavaScript errors/challenge. No real credentials were entered. Ignored screenshot evidence: `frontend/e2e/.artifacts/production-login-{dark,light}.png` and `frontend/e2e/.artifacts/account-release/`.
- The retained custom domain `https://intern.greenbp.dpdns.org` still returns the pre-existing Cloudflare 403 challenge to automated requests. Its mapping is retained; WAF/challenge settings were not changed. The workers.dev frontend is available independently.
- No production migration, account/password reset, secret change, invitation consumption or resource recreation occurred. The hosted demo remains `DEMO_ENABLED=true`, `AI_PROVIDER=mock`.
