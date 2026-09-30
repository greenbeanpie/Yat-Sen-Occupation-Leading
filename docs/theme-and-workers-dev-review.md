# Theme implementation and workers.dev review

This change is local only. No deployment, Cloudflare security changes, database migrations, account initialization, password changes or secret changes were performed.

## Theme

- Default follows `prefers-color-scheme`, including changes while the page is open.
- The top-right native select offers system/light/dark on login, invitation registration and the workbench. Explicit choices use `yso-theme` in localStorage; system removes that override.
- A same-origin blocking script initializes the theme before React and stylesheet rendering, compatible with the existing CSP (`script-src 'self'`). It also sets browser color scheme and theme-color.
- Live system changes, cross-tab storage updates/clear, unavailable storage and reduced motion are handled. Existing light surface colors and brand gradients remain; text/status colors use semantic variables for contrast.
- Shared CSS covers business pages, form controls, modal dialogs, badges, score tracks and mobile navigation. On narrow screens the sync pill is hidden to keep the theme control accessible.

## Verification

Frontend typecheck, lint, 42 unit tests and production build pass. Full repository `node scripts/deploy-preflight.mjs` passes 15/15, including backend checks, OpenAPI/type contracts, both Worker dry-runs and read-only D1/R2 account checks.

Run the browser acceptance with local demo Vite on 5174 and ordinary Vite on 5175:

```powershell
$env:CHROMIUM_PATH='C:\Program Files\Google\Chrome\Application\chrome.exe'
node frontend/e2e/theme.mjs
```

Artifacts and results are under `frontend/e2e/.artifacts/theme/` (ignored by Git): 41 screenshots and 8 passing browser acceptance groups. The script uses local fictitious demo data, including a generated matching result with score charts/condition states; the ordinary login session response is read-only and intercepted locally, with no credential or invitation submission. It checks live system changes, explicit override, reload, cross-tab synchronization, returning to system, keyboard selection, blocked storage, pre-React initialization, semantic palette contrast, desktop pages/modals, 390/320 pixel layouts and login/invitation registration screenshots. Final frontend checks pass with 42 tests; after the full 15/15 preflight, final Worker/resource dry-runs were reconfirmed with `--quick` (7 passed; the expected quick-mode skip warning).

## workers.dev: read-only findings and proposed release

Existing frontend Worker: `greenbp-intern-workbench`. Its configuration has `workers_dev: false`, the retained custom domain `intern.greenbp.dpdns.org`, SPA assets and `BACKEND` bound to `greenbp-intern-workbench-backend`. Frontend `/api/v1` and `/api/v1/*` requests are forwarded unchanged through this Service Binding; other paths serve the frontend.

Read-only HTTP results:

| URL/path | Result |
| --- | --- |
| `https://intern.greenbp.dpdns.org` | 403, `server: cloudflare`, `cf-mitigated: challenge`, HTML “Just a moment…” |
| `https://greenbp-intern-workbench.hddhp.workers.dev` | 404 Cloudflare HTML; entry currently disabled |
| `https://greenbp-intern-workbench-backend.hddhp.workers.dev/` | 404 JSON `not_found`, expected API-only entry |
| Backend `/healthz` | 404 JSON; missing API prefix |
| Backend `/api/v1/healthz` | 200 JSON `{"status":"ok"}` |

The challenge is Cloudflare edge protection, not the application's login/invitation denial. No CAPTCHA interaction or security-rule bypass was attempted. These HTTP observations do not identify the exact dashboard rule that issued the challenge.

Minimum proposed configuration change, pending parent-coordinated approval/release: set **only the existing frontend's** `workers_dev` to `true`, retaining its custom-domain route, assets configuration, Worker name and Service Binding. Deploy that frontend in place, then verify its workers.dev SPA routes and same-origin API/login behavior. No new Worker is needed. No configuration was changed in this task.

Backend CORS currently allows `https://intern.greenbp.dpdns.org`. Hono CORS controls cross-origin response headers rather than authorizing users or rejecting same-origin requests. The frontend workers.dev origin uses `/api/v1/*` on the same origin, so the existing Service Binding avoids a cross-origin API dependency. If direct cross-origin backend access is separately required, add the exact frontend workers.dev origin to the allowlist while retaining the custom origin; never use a wildcard. No such backend change is needed for the proposed same-origin site.

Session cookies are host-only (no Domain), `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`; each frontend hostname has its own browser login cookie. Existing invitation, session and administrator authorization remains in the backend. Enabling workers.dev adds another public entry and may not carry the custom zone's WAF/challenge protections: this needs explicit release/security review, and absence of future Cloudflare challenges cannot be guaranteed by code configuration alone.

**The new entry would call the same production backend and its production `yso-db` D1 / private `yso-docs` R2. It is not an isolated test database.** Authenticated writes there modify production state. Keep `DEMO_ENABLED=true` / `AI_PROVIDER=mock` as configured; local theme acceptance does not prove real production-account functionality.
