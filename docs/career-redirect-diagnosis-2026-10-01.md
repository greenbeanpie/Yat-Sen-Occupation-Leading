# SYSU source redirect diagnosis (2026-10-01)

The adapter still issues one public HTTPS request with the existing fixed User-Agent
and `redirect: manual`. It never follows a Location, retries, reads a login page,
forwards caller credentials, or changes the saved model configuration.

Redirect failures preserve the actual HTTP status and classify the destination as
a same-origin public route, other same-origin route, login, challenge, external,
non-HTTPS, invalid, or missing Location. Only fixed public paths/categories leave
the classifier. Arbitrary hostnames/path segments, query values, fragments and
userinfo are excluded. The source response/end diagnostics share the API request
ID, and use the existing 1,000-entry / 1,000,000-byte diagnostic retention limits.
HTTP 403 and 429 take precedence over an accompanying Location. Source failure
still starts the existing 15-minute protective cooldown and never enters AI.

A single Mac Node invocation of the actual backend adapter at
2026-10-01T15:18:10.785Z received HTTP 302 from `/campus/index`. Its Location was
classified as a same-origin login target, with query values removed. The adapter
stopped at the response; no parsing or model request occurred. This observation is
from Mac, not Cloudflare edge. Local correlation ID:
`3de958d2-ba06-46bf-be6d-823e30aad99b` (not a production API request ID).

The production refresh route and this Mac invocation both use `/campus/index`
without parameters. The recorded fixture provenance uses the same URL, and
`career-review-interface.md` records HTTP 200 / 20 announcements on that path at
12:03:40 UTC. The initial user-facing entry `/campus` differs, but this evidence
does not establish a path bug or authorize trying alternate routes after a login
response. A single normal authenticated UI request, after cooldown and deployment,
is needed to establish the actual Cloudflare edge redirect classification.

Validation: synthetic Location/status tests exercise redirect codes, missing and
malformed Location, login/challenge/external destinations, credential removal,
body cancellation, one fetch only, no parsing after failure, request-ID correlation
and the existing cooldown. Full backend regression: 404 passed / 1 skipped.
The strict repository deployment preflight passed all 16 gates, including frontend
checks, current API contracts, both dry runs and read-only production resource and
migration checks.
