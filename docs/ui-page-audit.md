# UI page audit

Audit worktree: `C:\Users\hmz\AppData\Local\Temp\yso-ui-page-audit`.
Branch: `ui-page-audit`; incorporates `main` at `84a4c43` before the UI changes.
Local instances: demo `127.0.0.1:5191`, intercepted HTTP fixture `127.0.0.1:5192`.
No production data, credentials, account changes, push or deployment were used.

## Confirmed issues and fixes

| Reproduction | Fix | Evidence |
| --- | --- | --- |
| A long private job title/company/source URL expands a 390px page to 1856px | Allow content and modal text to wrap; shrink flex/grid text containers and search input | `states-before/long-job.png`, `states-after/long-job-390-light.png`; final page and modal have no horizontal overflow |
| Closing the mobile sidebar moves it offscreen but leaves its links/buttons keyboard focusable | Hide the closed mobile sidebar; constrain open menu Tab navigation, close with Escape and restore focus; expose expanded state; release menu on desktop resize | `audit-states.mjs` keyboard checks |
| Mobile inputs use 9–11px text, including date and interview fields | Use 16px text on mobile input controls; keep the interview datetime field on a full row | `states-after/application-history-320-dark.png` |
| Long modal title squeezes the status badge into vertical letters | Keep the detail badge from shrinking or wrapping | `states-after/long-job-detail-320-light.png` |
| `unmet` receives the green `met` badge style | Match complete status values | `components.test.tsx` tests unmet/met/unknown colors |
| Jobs and other lists claim to be empty while requests are still loading | Pass loading state to shared list rendering, show a loader before an empty result, remove duplicate loaders and premature job count | `states-after/jobs-loading-390-light.png`, shared list regression test |

## Page and state coverage

All routes below were inspected in local Chrome at **1440 / 390 / 320px**, with
**light / dark** appearances. Theme controls were also exercised in **system**
mode with simulated OS appearance changes. Default route coverage has 48 route
observations plus six login screenshots; screenshots include full page content.

| Page | Additional coverage |
| --- | --- |
| Login | Demo identities; credential form; registration form; theme control |
| `/` dashboard | Seeded metrics, zero efficiency, empty recent plans |
| `/profile` | Profile forms, experiences, skills, evidence states, required-field feedback, resume parse draft, rejected quote, stale-version conflict dialog |
| `/jobs` | Public/private jobs, empty private list, loading, long title/company/URL/JD, creation dialog, detail dialog, disabled controls |
| `/match` | No selected job, analysis disabled state, generated explanation and score bars, recent analysis, generated portfolio |
| `/plan` | No portfolio/plan, service error, generated draft, confirmed plan, task forms, rewrite suggestions |
| `/applications` | Empty records and time entries, zero efficiency, populated application, history, interview form, feedback form |
| `/settings` | Demo restriction, account nickname/password forms, mismatch validation, long nickname, notifications/changes empty, pending queue and sync conflict |
| `/admin` | Normal demo identity denied by existing permission logic; browser-only authorized fixture for job list, create/edit dialogs; intercepted HTTP fixture for invitation creation and pending/expired/used/revoked records |

The four job dialogs and the stale-version dialog were captured at all six
viewport/theme combinations. Escape, modal focus restoration and Tab trapping
were exercised. Admin authorization is a **test fixture only**; the production
and demo permission checks are unchanged. Every API call in the HTTP fixture is
handled in the browser, including account and invitation endpoints.

## Validation and artifacts

- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` in frontend.
- Complete `scripts/deploy-preflight.mjs` with an isolated temporary Wrangler
  configuration: backend typecheck/tests, frontend gates, OpenAPI/type contract
  checks, both existing Worker dry-runs. Account/resource discovery remains a
  deliberate TODO because real credentials are excluded from this audit.
- Browser checks: `e2e/page-audit.mjs`, `e2e/audit-states.mjs`,
  `e2e/audit-account.mjs`. `CHROMIUM_PATH` points to installed local Chrome;
  route matrix/states use `WORKBENCH_URL` (default `http://127.0.0.1:5191`).
- Screenshot/JSON root:
  `C:\Users\hmz\AppData\Local\Temp\yso-ui-page-audit\frontend\e2e\.artifacts`.
  Relevant directories: `audit-before`, `audit-after`, `states-before`,
  `states-after`, `account`. These are ignored and remain in the retained
  worktree even after source integration.

## Material limits and handoff

- Windows Chrome responsive emulation was used; physical iPhone/Safari,
  Android browser rendering and screen reader speech were not available.
  The 16px input change is verified in computed Chrome styles; actual iOS
  auto-zoom needs a device check.
- Browser-native installation/update and push permission dialogs were not
  accepted. Actual PWA update delivery and VAPID push need release/device QA.
- Empty/loading/error, validation, disabled and conflict UI templates were
  exercised; every backend error code and every business status transition
  was not manually enumerated. Existing unit/API tests remain the contract
  coverage for those permutations.
- Actual password changes, account creation, credential login, invitation
  issuance, production D1/R2 and deployment were not performed. The account
  form's mismatch feedback was tested using fictitious input only.
- The legacy `e2e:demo` script assumes demo-admin navigation which the current
  permission policy denies; it was stopped after identifying that mismatch.
  This audit uses an explicit browser-only administrator fixture and preserves
  the current permission policy instead of relaxing it.
- Parent thread coordinates origin push and production deployment after the
  local integration. Keep the UI worktree/artifacts until evidence is retained.
