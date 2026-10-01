# AI provider configuration (web + operator)

This change adds provider-aware configuration and text request adapters. It does **not** enable real AI, configure credentials, change production selection, create a provider account, or make a paid validation call. The tracked production configuration remains `AI_PROVIDER=mock`, with blank `AI_BASE_URL` / `AI_MODEL`. Existing role, career-source review, archive, and job-budget enforcement are unchanged.

## Configuration ownership and compatibility

Non-demo super administrators now have **管理中心 → AI 模型配置**, backed by `GET/PUT /admin/ai-settings`. Existing administrator/student/demo roles cannot read or write these settings. The initial mode is `environment`, preserving deployment bindings and the existing `AI_API_KEY` secret. Other modes are `mock` and `real` (web configuration). Every operation re-reads the saved row; public demo identities are always forced to mock, even when web real mode is active. In-flight calls retain their bounded request snapshot.

The webpage has a separate protocol selector: automatic, OpenAI Compatible Chat Completions, Responses, Anthropic Messages, or Gemini GenerateContent. OpenAI supports manual Chat or Responses; custom supports Chat/Responses/Messages. A known provider/model rejects an incompatible protocol. Unknown Go/Zen models require an explicit Chat/Responses/Messages selection and cannot enable unverified effort/sampling fields. Selecting a protocol does not claim the remote endpoint supports it. Save does not make a test or paid model request.

The first web real configuration requires a user-entered API key over HTTPS. It **never inherits the deployment `AI_API_KEY`**. Web keys are encrypted server-side using AES-256-GCM with a random 96-bit IV and an HKDF-SHA256, purpose-separated key derived from the already-configured `SESSION_SECRET` (minimum 32 UTF-8 bytes). No new root secret is generated. Authenticated additional data binds the envelope to its configuration version plus provider preset, effective protocol, and canonical complete API root (including path). Changing any destination component requires key re-entry; option-only changes decrypt and re-encrypt for the next version. GET responses, logs and audits never return plaintext keys or ciphertext. The password field is blank after save/reload and is never persisted in browser storage or offline queues.

Missing/short encryption root, root rotation, tampered ciphertext, wrong AAD/version, missing settings row, or corrupted saved settings fail closed. They never silently revert to deployment credentials. After root rotation, sign in again and re-enter the provider key through the HTTPS page; old ciphertext is intentionally unreadable. Explicitly clearing the web key disables web real calls. Returning to environment mode is an explicit super-admin choice, not an error fallback.

`ai_settings` stores nonsecret configuration and ciphertext. `ai_settings_audit` stores actor ID, versions, key action (preserve/replace/clear), and timestamp, never the key. PUT requires authenticated non-demo super-admin access, same-origin/allowlisted Origin, JSON content type, a 16 KB bound, and optimistic version matching. The database batch rechecks active super-admin status inside the same transaction as audit/update. Ordinary users gain no settings privileges.

Apply reviewed migration `0008_ai_settings.sql` before releasing this backend. Do not drop or reset existing D1/R2 resources. This implementation/test pass did not apply a production migration, deploy, enter actual credentials, or activate real AI.

`AI_PROVIDER` remains `mock` or `openai`. The latter is the backward-compatible real-adapter selector, including native providers. Omitting `AI_PROVIDER_PRESET` retains `custom`: the existing API root plus `/chat/completions`, Bearer auth when a key exists, default temperature 0.2, and output cap 4096. Blank custom roots still fail, rather than returning mock data. A model name is now validated before any request. Existing local HTTP custom endpoints remain supported, but hosted career extraction still requires HTTPS and a configured key.

Select a preset through `AI_PROVIDER_PRESET`, set `AI_MODEL`, and leave `AI_BASE_URL` blank for the documented default. Operator-only root overrides are preserved for authorized enterprise gateways (Go is restricted to its exact official root); the operator is responsible for their compatible protocol and privacy. Do not include `/chat/completions`, `/responses`, `/messages`, credentials, query strings, or fragments in an API root. Redirects are never followed with credentials. Web settings additionally require public HTTPS hostnames on port 443/default, with no encoded path, IP literal, local suffix, userinfo, query, fragment, or traversal. The host must match an official preset hostname or an exact entry in operator-managed `AI_ALLOWED_HOSTS` (comma-separated, no wildcard). A custom root is not automatically trusted because a super-admin typed it; operators should approve domains and their DNS ownership before adding them. These checks are not a universal DNS-rebinding defense for an operator-authorized domain.

| Preset | Default root | Protocol |
| --- | --- | --- |
| `custom` | Required | OpenAI-compatible Chat Completions |
| `openai` | `https://api.openai.com/v1` | Responses |
| `anthropic` | `https://api.anthropic.com/v1` | Messages |
| `gemini` | `https://generativelanguage.googleapis.com/v1beta` | Native `models/{model}:generateContent` |
| `deepseek` | `https://api.deepseek.com` | Chat Completions |
| `openrouter` | `https://openrouter.ai/api/v1` | Chat Completions |
| `opencode-zen` | `https://opencode.ai/zen/v1` | Exact reviewed model-to-protocol map |
| `opencode-go` | `https://opencode.ai/zen/go/v1` | Exact reviewed model-to-protocol map |

The adapters are text-only. Streaming, tools, image/audio input, a native Gemini-through-Zen protocol, and Jev/System One are not implemented. Unknown OpenCode model IDs in automatic mode are rejected before networking instead of guessing a protocol; an explicit supported protocol permits basic text-only use without optional controls; other unknown models may use provider defaults but cannot opt into unverified optional controls.

## Bounded common options

All values are strings in environment bindings; the webpage uses typed controls. Blank web sampling fields omit the option, while legacy environment defaults are retained. Blank/unset values use defaults; explicit invalid or unsupported settings fail before networking.

| Variable | Behavior |
| --- | --- |
| `AI_PROTOCOL` | `auto` (default), `chat-completions`, `responses`, `messages`, or native `generate-content`; incompatible preset/model pairs reject |
| `AI_GO_USER_AGENT` | Go only: `YatSenOccupationLeading/` followed by a version label; other client identities reject |
| `AI_ALLOWED_HOSTS` | Additional exact public HTTPS hosts for web-configured custom roots; no wildcard or private/local targets |
| `AI_REASONING_EFFORT` | Unset/`default` omits reasoning controls. Other values must match the table below |
| `AI_THINKING_BUDGET` | Only Gemini 2.5 Flash/Pro, integer 0–4096; Pro minimum 128. Must be strictly below output cap. Cannot combine with effort |
| `AI_TEMPERATURE` | 0–2, only verified sampling-capable models; defaults to 0.2 for legacy custom and supported OpenAI/DeepSeek non-thinking modes; Gemini leaves it unset |
| `AI_TOP_P` | 0–1 where supported; current DeepSeek thinking mode requires 0.95–1 |
| `AI_MAX_OUTPUT_TOKENS` | Integer 1–4096, default 4096; cannot raise the preexisting hard output limit |
| `AI_TIMEOUT_MS` | Integer 1000–60000, default 60000; task-specific 30-second extraction cap still takes precedence |
| `AI_MAX_ATTEMPTS` | Integer 1–3, default 3; task-specific single-attempt extraction still takes precedence |
| `AI_REQUEST_HEADERS_JSON` | OpenRouter attribution only: `HTTP-Referer` and one of `X-OpenRouter-Title` / legacy `X-Title` |

Input stays capped at 100,000 UTF-8 bytes. Responses are now byte-bounded for all providers (1 MB; extraction keeps its tighter 150 KB bound). Truncated, refused, tool-only, malformed, and empty answers fail without exposing reasoning blocks as answers. This does not introduce a currency budget, prove model quality, or guarantee a useful answer within 4096 tokens; high-effort reasoning can exhaust that limit. Existing operation quotas and career-source rate limits remain the spending controls outside these per-call caps. Provider-side billing, retention, plan eligibility, and overage settings remain the operator's responsibility.

## Conservative capability matrix

Reviewed 2026-10-01. An endpoint's presence does not establish optional-parameter support. Controls not listed here are rejected, not silently ignored.

- Custom Chat Completions: temperature/top-p, no reasoning field. This explicitly preserves the operator-selected compatibility contract; changing to a vendor preset enables vendor-aware validation
- OpenAI `gpt-4.1`, `gpt-4.1-mini`, `gpt-4.1-nano`, `gpt-4o`, `gpt-4o-mini`: temperature/top-p; no effort
- OpenAI `o3`, `o3-mini`, `o4-mini`: low/medium/high, no sampling
- OpenAI `gpt-5`, `gpt-5-mini`, `gpt-5-nano`: minimal/low/medium/high, no sampling
- OpenAI `gpt-5.1`: none/low/medium/high; sampling only with explicit none
- OpenAI `gpt-6-sol`, `gpt-6-luna`: none/low/medium/high/xhigh/max; sampling only with explicit none
- OpenAI `gpt-6-astra`, `gpt-6.1-sol`: low/medium/high/xhigh/max; no sampling
- Anthropic `claude-opus-4-6`: low/medium/high/max via adaptive thinking plus `output_config.effort`. Sampling and effort on other Anthropic models are left unavailable until model-specific validation
- Gemini `gemini-3.8-flash`, `gemini-3.7-flash`, `gemini-3.1-pro-preview`: low/medium/high via `generationConfig.thinkingConfig.thinkingLevel`
- Gemini `gemini-3-flash`, `gemini-3.5-flash`, `gemini-3.6-flash`: minimal/low/medium/high; no sampling exposed for these reasoning models
- Gemini `gemini-2.5-flash`, `gemini-2.5-pro`: numeric thinking budget and sampling; no named effort
- DeepSeek `deepseek-flash`, `deepseek-v4-pro`: none/low/high/max via `reasoning_effort`. Thinking is the vendor default; temperature only with none, top-p only with thinking and at least 0.95. Old `deepseek-chat` / `deepseek-reasoner` IDs are not new preset recommendations
- OpenRouter `openai/gpt-5`: minimal/low/medium/high via nested `reasoning.effort`, with `provider.require_parameters=true`. Other models' effort is rejected pending verified `/models` metadata; upstream names alone are not a capability guarantee. No sampling exposed
- OpenCode Go/Zen: supported endpoint and output cap; no extra effort or sampling options until gateway-specific model semantics are verified. Underlying-vendor capability is not assumed

For example, choosing `gpt-5` and leaving `AI_REASONING_EFFORT` unset uses its provider default. Setting `AI_REASONING_EFFORT=none` is rejected for that model. Explicit incompatible temperature or top-p is rejected. The career extraction task supplies temperature zero only when the provider reports that temperature is supported.

## OpenCode Go request-header adapter

The Go adapter sends `User-Agent: YatSenOccupationLeading/1.0` and an opaque `x-opencode-session`. It does not impersonate OpenCode, manufacture coding prompts, or retry a denial with a different identity. A provider instance generates one random session ID, reused for its turns and retries. Current application operations are single-conversation tasks and explicitly reuse their opaque random operation UUID across reconstructed providers/workflow retries. A future multi-turn caller re-creating providers must supply the same random `CompletionOptions.sessionId` for that conversation; never use user IDs, emails, global shared IDs, or a new ID for each retry. Independent instances generate different IDs.

Go's official documentation positions it for OpenCode/other coding agents and describes expected coding-agent requests. P1's recruitment, CV and announcement tasks are business workloads. **This adapter does not establish that those workloads are eligible under the user's Go plan. Confirm applicability with the provider before real use.** No production opt-in was made. `403` and other non-429 4xx fail once, retaining only status in the safe error. The application does not automatically fall back to Zen credit or another provider; a provider-account “Use balance” setting can still incur overage, so review it separately.

Protocol examples (the complete explicit IDs are in `backend/src/infra/ai/config.ts`):

- Go `glm-5.3`, Kimi/DeepSeek/MiMo: `/chat/completions`, Bearer auth
- Go `minimax-m3`, `minimax-m2.7`, Qwen: `/messages`, `x-api-key` and `anthropic-version: 2023-06-01`, system text separate
- Go `gpt-6-luna`, GPT 5.6 Luna, Grok, Muse Contributor: `/responses`, Bearer auth
- **Zen differs:** MiniMax and `qwen3.8-max` use Chat Completions, while Claude and other supported Qwen IDs use Messages. Never copy Go's routing assumptions to Zen

Nonsecret header configuration cannot override Authorization, x-api-key, x-goog-api-key, Content-Type, User-Agent, session identity, cookies, proxy/forwarding headers, or API versions. Header values reject control characters and long values. OpenRouter referers require HTTPS without credentials, query or fragment. Supply only public application attribution; never put credentials or user data in these fields. Environment-mode keys remain in `AI_API_KEY`; web-mode keys live only in authenticated ciphertext in D1 and transient server request memory. Changing root/preset/protocol cannot reuse the old web key.

## Verification and sources

New automated API tests cover permissions, CSRF, HTTPS-only key submission, persistence/reload, CAS conflicts, key re-entry on destination/path/protocol changes, encrypted version updates, tampering/wrong AAD/short root/rotation, missing-row corruption, demo isolation, redaction, host checks and disabled dispatch without a key. Static-rendering frontend tests cover role-gated access, protocol controls, password non-refill, conditional options and disabled unsafe states.

`frontend/e2e/ai-settings.mjs` defines interactive save/double-submit/reload/conflict/cancel/back-navigation and desktop/mobile screenshot checks with synthetic mocked APIs. It has **not completed in this cloud workspace**: Chromium cannot create its local socket (`Operation not permitted`), including the normal-permissions retry, and the tool cloud browser blocks the local dev URL (`ERR_BLOCKED_BY_CLIENT`). Browser screenshots and interactive browser acceptance therefore remain unverified; run the script in an allowed desktop/CI browser environment before production rollout.

All integration requests are intercepted with deterministic fixtures. Tests assert the actual URL, auth/identity headers and serialized body for each protocol, distinct Go/Zen routes, stable retry sessions, unknown/unsupported option rejection, old env compatibility and a nonsecret config round trip. No provider-account live test has been run, so fixture success is protocol-contract evidence, not paid-access or model-quality verification.

Official references:

- [OpenCode Go usage, headers and endpoints](https://opencode.ai/docs/go/)
- [OpenCode Zen endpoint table](https://opencode.ai/docs/zen/)
- [OpenCode Go Messages auth route](https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/console/app/src/routes/zen/go/v1/messages.ts)
- [OpenAI latest model guidance](https://developers.openai.com/api/docs/guides/latest-model)
- [OpenAI deployment checklist](https://developers.openai.com/api/docs/guides/deployment-checklist#set-up-reasoningeffort)
- [Anthropic Messages](https://platform.claude.com/docs/en/api/messages/create) and [effort](https://platform.claude.com/docs/en/build-with-claude/effort)
- [Gemini thinking](https://ai.google.dev/gemini-api/docs/generate-content/thinking?hl=en#thinking-levels-gemini-3)
- [DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)
- [OpenRouter reasoning](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens) and [model metadata](https://openrouter.ai/api/v1/models)

Provider model catalogs change. Refresh the reviewed exact capability/endpoint tables and request tests together; never “fix” a 400/403 by blanket forwarding unverified controls or spoofing a client.
