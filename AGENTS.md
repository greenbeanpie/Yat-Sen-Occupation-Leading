# Repository Instructions

## Engineering workflow

- For non-trivial changes, inspect the affected code and dependencies, state a short implementation plan, then execute and verify it.
- Prefer the smallest change that fully addresses the task. Fix underlying causes and avoid unrelated refactors.
- Run the relevant type checks, lint, tests, build, contract checks, and deployment preflight before calling a change complete. Report the files changed, checks run, results, and material limitations.

## Project layout and checks

- `frontend/` is the React/Vite workbench and its Cloudflare static-assets Worker.
- `backend/` is the Hono API Worker, D1 migrations, R2 integration, Workflows, cron, and API tests.
- `scripts/` contains repository-level deployment preflight and Cloudflare resource bootstrap tools; bootstrap defaults to read-only plan mode.
- For backend changes, run `npm run typecheck` and `npm test -- --no-file-parallelism` from `backend/`.
- For frontend changes, run `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build` from `frontend/`.
- Run `node scripts/deploy-preflight.mjs` before a Cloudflare deployment and `node backend/scripts/smoke-deploy.mjs <backend-url>` afterward.

## 发布要求

- 每次实质性功能更改合入 `main` 后，都必须将 `main` 推送到 `origin`，并部署到 Cloudflare 生产环境；实质性更改包括会影响用户可见行为、运行逻辑、数据结构或 API 契约的代码变更。
- 发布前运行受影响项目的检查，并通过 `node scripts/deploy-preflight.mjs`；只部署本次变更涉及的既有 Worker，若前后端都需发布，先部署后端再部署前端。
- 部署后验证生产域名和受影响功能，并记录提交与部署结果；若凭证、平台状态或验证失败阻止发布，应明确报告阻塞原因，不得声称已部署。

## Git branch policy

- `main` is the only persistent local and remote branch. Before deleting any branch, verify its tip is an ancestor of `main` and inspect the live remote branch list; never delete `main`.
- Use a temporary worktree for isolated code changes when practical, then merge verified work into `main` and remove the temporary worktree.

## Cloudflare production constraints

- Deploy the frontend to the existing Worker `greenbp-intern-workbench` at `https://intern.greenbp.dpdns.org`. Keep `workers_dev: false` and its custom-domain route in `frontend/wrangler.jsonc`; do not create another frontend Worker for this project.
- The backend Worker is `greenbp-intern-workbench-backend`. The frontend's `BACKEND` Service Binding must target that exact Worker name so `/api/v1/*` stays same-origin.
- Deploy the backend before the frontend. Update CORS allowlists when the production frontend origin changes.
- `yso-db` (D1) and `yso-docs` (private R2) contain production state. Never recreate, reset, or delete them as part of routine deployment. Apply schema changes through reviewed migrations.
- Verify the Cloudflare account's existing Worker name and bindings before any production deploy. Prefer an in-place Worker rename when changing a Worker name so its identity, secrets, and bindings are preserved.
- Before deleting a Worker, verify its exact account, immutable Worker ID, name, custom-domain mappings, and inbound Service Bindings. Avoid ambiguous positional `wrangler delete` commands when a Wrangler config is active; use an exact-ID Cloudflare API request after the checks pass.
- Do not print, commit, or otherwise expose Wrangler OAuth tokens, API keys, Worker secret values, `.dev.vars`, or private key material. Set Worker secrets with Wrangler's secret commands; keep local values in ignored `.dev.vars` files.
- The hosted experience intentionally remains a public demo: `DEMO_ENABLED=true` and `AI_PROVIDER=mock` are expected unless the task explicitly changes the product mode. Do not describe it as real-user authentication or real-model operation.
- A deployed Worker cannot reach a model API at a user's `localhost` or `127.0.0.1`. Production model endpoints must be reachable over HTTPS from Cloudflare; keep API keys in Worker secrets.
- Never deploy from an unintended Wrangler config or delete a Worker until the intended replacement has been deployed and verified.
