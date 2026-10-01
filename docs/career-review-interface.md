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

## Production check and targeted compact-output correction

The authenticated production flow on 2026-10-01 returned HTTP 200 for its one
first-page read and announcement 997448 detail. Source metadata/hash matched the
cloud capture; images remained unread. The one extraction at 12:41:13 returned
`career_extraction_failed`. Its model trace showed one dispatch, DeepSeek HTTP 200
after 16.3 seconds, followed by `output_limit` while parsing the completion. No
candidate was stored and no source job was created. This was a model output-budget
failure before candidate/evidence validation, not a source-access/network failure.
The saved configuration stayed at version 1 with 4096 output tokens and default
reasoning. Since no response body/usage is retained, the trace does not identify
the exact split between reasoning tokens and generated JSON.

The targeted correction replaces the internal model's repeated evidence quotes
and full role-section text with short facts and numbered source-line ranges.
The server recovers every original quote and UTF-16 offset from the immutable
source, then applies the existing strict schema/verbatim-value, range, role-scope,
non-overlap and deadline checks. Unknown/conflicting facts are not fabricated or
silently repaired. The public review candidate remains schema version 1; only the
internal model output protocol is version 2. The nine-role recorded-source fixture
uses less than half the old JSON size while retaining full original evidence in
the review response.

The saved model, reasoning strength, token budget, request count, source request
policy and publication boundary are unchanged. Length failures still reject the
incomplete completion and now expose the precise sanitized `career_output_limit`
error, with no automatic retry or hidden budget increase. Real compact-output
extraction remains pending a targeted production retry after release.

## Fixed information list and missing-data tolerance

The program's closed schema defines these fields; the model cannot add arbitrary
extras. Every displayed slot has `known`, `unknown` or `conflict` state. Known and
conflicting alternatives require exact original evidence. Missing model fields
default to unknown, not invented values or a failed whole announcement. The
server generates the complete missing/pending-review list without asking the
model to repeat it.

- Announcement: title, employer, application deadline, total recruitment count,
  announcement-wide remuneration, application channels, application materials,
  common requirements
- Each evidenced role: title, work locations, education, recruitment count,
  majors, remuneration, application materials, role-local requirements

Majors, locations, channels, materials and requirements are typed arrays with
separately evidenced items, not unverifiable combined strings. Unknown whole
arrays remain null. Lists are displayed up to 10 items (requirements up to 30).
Hitting the cap or containing unknown entries explicitly marks the review partial
with its affected field; this is not silent truncation or a claim of completeness.
Only-image/embedded announcement bodies can be previewed as partial text snapshots
with unknown role facts; image contents are never inferred or fetched. A truly
empty body without media or malformed evidence still fails safely.

The old singular location and nullable fact fields remain compatible; newly
recovered reviews additionally supply the complete typed checklist and multi-value
locations. Title-year contradictions keep both source-backed alternatives and no
chosen title. Website expiry cannot become a deadline, even as a purported conflict
alternative. Role evidence cannot become announcement-wide count/remuneration or
common hard conditions. Semantic correctness remains a human-review responsibility.

## Explicit temporary diagnostic budget

The compact production retry still exhausted 4096 tokens. Its trace identified
the newly saved version 2 destination as OpenCode Go `deepseek-v4.1-flash`, rather
than the native DeepSeek provider used by the first attempt: one request, HTTP 200,
27.4 seconds, `output_limit`, no draft and no published job. No response text was
retained, so the split between reasoning and final JSON cannot be inferred.

After explicit user authorization for higher test token usage, a non-demo super
administrator can choose 16,384 (first test) or 32,768 tokens and click the separate
temporary diagnostic action. The operation is bounded to 120 seconds and one
request with no retries, uses the current saved destination/key/model and reasoning
settings, and does not save or alter global configuration. Ordinary extraction and
other model features retain the administrator's saved limits. The approved current
model is constrained to a conservative 32k project test cap below its published
inherited model limit. Unsupported/unverified models do not get a guessed override.

The request includes the current configuration version and a random request ID.
Server-side current super-admin permission/version/source freshness checks run
before dispatch; duplicate request IDs cannot create a second paid attempt. The
existing global model lease protects against concurrent extraction. Successful
test output remains review-only and may populate the same source-revision cache;
it carries the explicit diagnostic limits/request ID so cached reuse is not
represented as another model request.

Logs and reports now include only whitelisted numeric input/output/reasoning token
counts when the provider supplies them, otherwise null. Malformed values, arbitrary
usage keys, response text, private reasoning text and headers are not copied. The
same 1000-entry/1,000,000-byte retention and logging-failure isolation still apply.
The next real temporary-budget test remains pending after deployment.

Protocol references: [OpenCode Go endpoints](https://opencode.ai/docs/go/),
[official Go model registry](https://raw.githubusercontent.com/anomalyco/models.dev/dev/providers/opencode-go/models/deepseek-v4.1-flash.toml),
[model limits database](https://models.dev/).

## Source failure classification

For the owner-reported later fetch failure, the production read-only evidence
showed source protection cooling down from 14:16:26.229 to 14:31:26.229 UTC and no
AI diagnostic after 14:10. The old source handler had collapsed all underlying
fetch/parser reasons, so that historical failure cannot be asserted to be HTTP403,
timeout or a script error, nor attributed to the earlier model output limit.

New source operations persist safe `source_fetch`, response, decode/parse and end
stages with the HTTP request ID. Fixed codes now distinguish remote 403, remote429,
challenge/redirect/other HTTP, timeout, network failure, decoding incompatibility,
parser incompatibility, size protection and internal script/storage errors.
Errors display the matching code and request ID in the review panel. Raw HTML,
exception messages/stacks and personal content are not stored; logging failure
does not change the source outcome. No migration, alternate source route, UA
rotation or automatic source retry is introduced. The next single low-frequency
production source action is needed to establish the current actual cause.
