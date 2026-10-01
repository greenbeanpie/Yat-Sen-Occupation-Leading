# SYSU announcement extraction: isolated feasibility prototype

## Scope and plan

1. Preserve the released checkout; build a standalone extraction module in a temporary worktree.
2. Accept bounded, sanitized, explicitly partial rendered text plus source provenance.
3. Call the existing `AiProvider` interface; validate strict JSON, verbatim values, exact evidence offsets and role scope.
4. Return a human-review draft with source hash; never import, schedule, publish, fetch links or mutate the database.
5. Exercise adversarial and real-observed excerpt fixtures; separately report real-model and source-access limits.

Implementation: `backend/src/prototypes/career-announcement.ts`.
Tests: `backend/test/career-announcement.test.ts`.
Real source fixture: `backend/test/fixtures/sysu-observed-dom-excerpts.json`.

## Feasibility verdict

Text-to-reviewable-structured-data is technically feasible through the existing provider adapter. This branch validates the offline contract and deterministic safeguards, NOT live LLM accuracy, unattended ingestion, extraction recall or production readiness.

Direct default server-side GET to `/campus` and verified detail `/campus/view/id/997448` returned HTTP 403 on 2026-10-01. A SYSU-branded block page listed possible campus/VPN/service-hours/security causes; the actual cause is unknown. Earlier cloud-browser accessibility observations were readable without login, but that does not prove static HTML or Cloudflare Worker fetch compatibility. No bypasses, alternative headers/proxies or further scraping were attempted. No public API/feed or reuse policy was verified. Automatic ingestion must remain disabled pending an authorized source method. Pinned older list entries also prohibit stopping pagination at the first old record.

The fixture uses sanitized, manually transcribed excerpts from 2026-09-30 23:56–23:58 UTC cloud-browser observations. It is neither a full snapshot nor original HTML. Source offsets in demonstrations refer to the locally assembled excerpt text (with explicit boundary markers), not the original DOM/HTML. Adjacent excerpt assembly is not proof of original adjacency. No image/QR content was decoded. Contacts were excluded.

## Model capability and limits

Tracked `backend/wrangler.jsonc` sets `AI_PROVIDER=mock`, `AI_BASE_URL=""`, `AI_MODEL=""`; production intentionally remains a public demo. No secret files, secret values or credentials were read. No external model request was sent. The existing `getAiProvider` already supports `openai` via an OpenAI-compatible `/chat/completions` adapter; this prototype injects that same `AiProvider` interface. Existing mock intentionally fails this new task as unsupported instead of returning pretend extraction. Tests inject a clearly labeled fixture provider. Real LLM validation requires an authorized reachable endpoint/model and any required credential configured through existing secret facilities; that is not established here. No provider configuration was changed.

## Contract and safety properties

- URL origin and numeric detail ID are checked; publication date and website expiry remain source metadata, separate from application cutoff
- 30,000-character input and 100,000-character returned JSON limits; strict versioned Zod schema; unknown keys rejected
- Only rendered plain text accepted; HTML rejected, invisible control/bidi formatting removed; source remains untrusted data in the prompt
- Facts use exact original wording and UTF-16 evidence offsets; absent/unclear fields are null
- Non-overlapping role sections and role-local evidence prevent simple cross-role quote mixing; unknown requirements stay null
- Application deadline needs explicit application/submission cutoff wording, not an expiry label
- SHA-256 includes sanitized text, source URL/ID, publication/expiry, capture method and completeness; retrieval time excluded
- Every result is `needs-human-review`; evidence checks are syntactic, not proof of semantic entailment or source truth. Broad or wrongly selected sections and semantically misassigned verbatim text remain review risks. Metadata provenance is supplied by the capture step, not independently revalidated against the site
- The adapter has no tools, URL fetching, imports or publication. Source instructions/URLs remain data. Prompt injection cannot be proven prevented by a prompt or these tests; generated facts remain review-only
- `assertFreshDraft` compares against a newly captured source hash. Future persistence must compare source/JD versions atomically with confirmation; this prototype does not reuse the existing JD confirmation route and does not claim that route fixed

The conservative contiguous role-section schema cannot automatically associate all of Shanghai Bank's cross-referenced requirements (listed later in the document) with individual role sections. Such requirements must stay unknown with an ambiguity for review, rather than silently being applied to everyone. This is an explicit MVP limitation.

## Actual examples

- 997448: nine role categories, different education thresholds; location null because Beijing/Wuhan refer to exam sites; application deadline null despite source expiry 2026-11-30; title 2026 vs body 2027 preserved as ambiguity
- 997447: resume submission explicitly closes 2026-11-22; graduation eligibility and later assessment/offer dates are separate; no invented exact job IDs, image-derived application links, per-role workplaces or current availability

## Integration next step

First establish an allowed reliable source (manual pasted body text is sufficient for a preview; automated capture is unproven). Then run a small labeled evaluation on complete authorized captures using the user's explicitly configured real provider, checking schema pass rate, evidence support, missing facts, multi-role scope, date correctness and adversarial source instructions. Add a review UI and atomic source/JD freshness check only after that result, before any job import. Review source-use policy and retention/contact minimization. No route, UI, schema migration, schedule, deployment or production resource change is included here.

## Verification record

- Backend TypeScript check passed
- Focused extraction suite: 18/18 passed, including exact URL constraints, span bounds, fabricated values, role mixing, deadline confusion, source changes and real observed excerpts
- Independent reviewer reproduced and rechecked rejection of oversized evidence spans, wrong source paths and credential-bearing URLs
- Initial full backend suite: 146 passed, 1 skipped, 1 failed (before three additional extraction tests). Failure in the existing plans statistics test at line 395 was independently reproduced on released commit `1685216b3a0d7cd7bc5d30966b7b5a8944c22090`: it queries September 2026 while generated interview events use the current October clock. It is unrelated to this unregistered standalone module
- No frontend files changed; frontend checks not applicable. No deployment planned; deployment preflight/live smoke tests not run. No live LLM test performed

### Separate test-fixture clock correction

The pre-existing statistics test has a separate test-only correction: use one captured current UTC anchor for `spentOn` and a one-day-padded query window because Workerd timestamps status transitions with its real clock. The test resets its database and creates exactly one interviewed application, so the padding does not aggregate unrelated records. This avoids month rollover failures without changing any application logic; it is not a frozen-clock or date-boundary test.

After this correction, final backend checks passed: TypeScript; all 22 test files, 150 tests passed and 1 pre-existing test skipped (151 total), including all 18 extraction tests. `git diff --check` passed. No live model calls or production deployment occurred.
