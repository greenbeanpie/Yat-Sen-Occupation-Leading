# SYSU source review interface

## Scope

The non-demo administrator public-job page (`/admin/jobs`) now includes a manual
SYSU public announcement review panel. It uses the existing career-source API:

- GET status reads only saved model availability and the server list cache
- Click "获取首页公告" reads or reuses the first list page
- Click "预览来源" reads or reuses one numeric announcement's static text snapshot
- Click "提取待审核候选" sends only its ID and immutable source hash to the existing
  real-provider extraction endpoint. It may consume model quota. The endpoint
  makes at most one model request and reuses a same-source candidate when cached

Nothing in this interface creates, confirms, imports or publishes a public job.
There are no scheduled requests, automatic pagination, automatic extraction,
automatic retries, personal profile inputs or browser-persistent review records.
The server remains authoritative for non-demo administrator access, source
request fencing/cooldowns, rate limits, real-model availability and source expiry.
No new database schema or migration is required.

## Review contract

Source publication date and website expiry remain provenance, separate from an
application deadline. Images, QR codes and embedded material are not fetched;
partial sources are visibly flagged. Every unknown fact stays unknown. Candidates
show original quoted evidence, UTF-16 offsets and separate role sections.
Syntactic evidence checks do not establish semantic correctness, completeness or
current job availability. Every candidate requires human review against the full
original page. Source and model text are rendered as escaped React text, never
active HTML.

The click controller prevents simultaneous duplicate calls, binds extraction to
the selected source hash, refuses expired/changed sources, and surfaces HTTP
errors without manufacturing success. A version conflict requires a new explicit
preview, not an automatic refetch/model retry. A failed list refresh retains the
existing in-memory review alongside the error.

## Real public-source check (2026-10-01 UTC)

Using the previously authorized fixed User-Agent, cloud read-only validation made
one GET to `/campus/index` at 12:03:40 (HTTP 200; 57,108 bytes; 20 announcements)
and one GET to `/campus/view/id/997448` at 12:05:06 (HTTP 200; 58,338 bytes).
No redirects, assets, subsequent pages or retries were requested. The existing
Workers parser then processed those exact raw responses offline: 2,133 characters
of announcement body, original date preserved, website expiry preserved, and
`partial=true` because two images were not read. Temporary captures remain outside
the repository and contain no personal user profile.

This establishes current public-source reachability from the cloud validation
environment and parsing compatibility; it does not establish production Worker
egress, real-model extraction quality or image-derived completeness. Those require
the bounded authenticated production flow, reported separately after release.

## Checks before integration

- Full frontend: typecheck, lint, 153 tests and production build passed
- Existing career backend suites: 91 tests passed (no backend change)
- The standalone cloud-local fixture browser script covers explicit fetching,
  visible model failures, duplicate-click suppression, source evidence and desktop /
  mobile overflow. Execution was blocked by the environment's Chromium socket
  restriction and subsequent review denial; no browser pass is claimed. Final
  production UI and bounded real extraction are pending the authorized browser QA
