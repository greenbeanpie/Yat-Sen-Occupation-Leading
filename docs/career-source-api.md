# SYSU career source: backend integration v1

Backend-only release. Existing jobs, accounts, tickets and UI remain unchanged. This API reads publicly accessible campus announcements into a bounded cache and optionally produces **human-review-only** extraction candidates. It never schedules crawls, publishes jobs, or follows application links.

## Frontend contract

Use generated `frontend/src/api/schema.ts` from the committed OpenAPI snapshot. All paths below have `/api/v1` prefix and require an existing **non-demo administrator** session cookie. Student/demo/anonymous callers receive 403/401. Responses are `Cache-Control: no-store`.

- `GET /admin/career-source`: local cached index (nullable), capability status, TTL. Never contacts the source or model.
- `POST /admin/career-source/refresh`, JSON `{}`: return cached index or fetch the fixed campus index once. No pagination yet. At most 30 list rows; they are announcements, not individual jobs.
- `POST /admin/career-source/preview`, JSON `{"id":"997448"}`: cached or one detail fetch; returns title, employer, plaintext `source`, `source.versionHash`, provenance, expiry and warnings. Render every returned string, including model ambiguities, as text, never HTML. The snapshot includes labeled source title/publisher plus body so its hash also changes when those fields change. Source dates retain their original strings/timezone ambiguity. Source expiry is not an application deadline.
- `POST /admin/career-source/extract`, JSON `{"id":"997448","sourceVersionHash":"<64 lowercase hex characters>"}`: extracts only the corresponding unexpired server-side snapshot. The client never submits source text or URLs. Response `status` is always `needs-human-review`, with schema-versioned candidate fields and exact UTF-16 evidence offsets. Unknown facts are null; one announcement may have many roles. Evidence checks are syntactic, never semantic verification.

POST requests require JSON and an explicit Origin matching the request origin or configured frontend allowlist. Browser same-origin fetch supplies Origin automatically; use credentials `include` when appropriate. Cross-site Fetch Metadata is rejected. Do not expose these administrative actions in the student UI.

## Important errors

Existing `{error:{code,message,details?}}` envelope:

- `real_model_unconfigured` (503): expected in current production `AI_PROVIDER=mock`. No model call or fake extraction is made. Real extraction needs separately approved operator configuration (HTTPS provider, model and key) before testing.
- `career_busy` (429): global source/model lease or protection cooldown. Do not busy-retry.
- `career_source_unavailable` (502): network, access denial, challenge, size limit or changed markup. Source traffic stops for 15 minutes. Do not rotate User-Agent or use another access route.
- `source_version_conflict` (409): preview expired or changed. Preview again; discard old candidates.
- `career_extraction_failed` (502): model failure or invalid evidence/JSON. No usable candidate returned.

## Limits and consistency

15-minute cache, at most 100 entries. A D1 atomic global lease serializes source requests and spaces completions by at least 1.1 seconds; all source failures trigger 15-minute cooldown. Fetch only fixed HTTPS campus index or numeric detail paths using the one approved fixed User-Agent. No cookies/auth, redirects, assets, JavaScript execution, external links, or arbitrary URLs. Parsing/decompression and body sizes are bounded.

Model requests are one attempt, 30-second timeout, 150KB response cap, no redirect following, one global concurrent extraction and quotas of 3 attempts per announcement/hour and 10 total/hour. Same-source results are cached. The source version/expiry is checked again after model completion. There is no confirm/publish endpoint or persistent job write, and no semantic correctness claim.

A future publishing feature must re-fetch and compare source versions and perform its confirmation write atomically with the chosen version; this backend release intentionally does not implement that operation.

## Deployment and live verification

Apply only additive migration `0007_career_source_cache.sql` to the existing D1 database, then deploy only `greenbp-intern-workbench-backend`; preserve bindings/secrets/vars/workflows and existing accounts. Local workerd fixture tests prove parsing of captured raw HTML, not access from the deployed edge.

After deployment, public health/OpenAPI and unauthenticated 401 checks can run automatically. To verify actual edge fetch, the owner signs in through the existing site with a real admin account, then from that same site's browser console runs:

```js
const res = await fetch('/api/v1/admin/career-source/refresh', {method:'POST', headers:{'Content-Type':'application/json'}, body:'{}'});
console.log(res.status, await res.json());
```

After at least 1.1 seconds, use the same shape on `/preview` with body `JSON.stringify({id:'997448'})`. Do not share cookies/passwords or copy session tokens. Successful cached responses alone do not prove a new source fetch; inspect `retrievedAt` and compare with the prior status response. Expect extraction 503 while production remains mock. No production model call should be claimed or executed without approved configuration.
