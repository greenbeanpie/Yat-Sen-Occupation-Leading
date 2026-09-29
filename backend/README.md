# Yat-Sen 求职辅助系统 — 后端

Cloudflare Workers 全托管的 `/api/v1` JSON API。技术栈与架构见仓库根 [backend_plan.md](../backend_plan.md)；产品范围见 [PLAN.md](../PLAN.md)。

- 运行时：Cloudflare Workers（Hono + @hono/zod-openapi + Zod）
- 存储：D1（结构化数据）、R2 私有桶（原始文件）
- 异步：Cloudflare Workflows ×5（文档解析 / 岗位要求解析 / 匹配解释 / 计划生成 / 简历改写）
- 定时：Cron Triggers（每 15 分钟，提醒调度）
- 推送：Web Push（VAPID + aes128gcm，纯 WebCrypto 自实现）
- 契约：`GET /api/v1/openapi.json` 在线提供；快照提交在 `openapi/openapi.json`（前端代码生成的唯一来源）

## 快速开始

```bash
cd backend
npm install
npm run db:migrate:local   # 本地 D1 建表
npm run dev                # wrangler dev，默认 http://127.0.0.1:8787
```

演示身份在首次访问 `GET /api/v1/session` 时自动种子（1 管理员 + 2 学生），登录：

```bash
curl -X POST http://127.0.0.1:8787/api/v1/session \
  -H 'Content-Type: application/json' \
  -d '{"userId":"10000000-0000-4000-8000-000000000001"}'   # 学生
```

## 常用脚本

| 命令 | 作用 |
|---|---|
| `npm run dev` | 本地 wrangler dev（真实 workerd） |
| `npm test` | Node 池测试（esbuild 打包 + Miniflare 真实 workerd/D1/R2） |
| `npm run typecheck` | tsc --noEmit |
| `npm run export:openapi` | 重新生成 openapi/openapi.json 快照（契约变更后必须执行） |
| `npm run gen:migrations` | 从 src/infra/db/schema.ts 重新生成 migrations/0001_init.sql |
| `npm run db:migrate:local / :remote` | 应用 D1 迁移 |
| `npm run generate:vapid` | 生成 VAPID 密钥对 |

## 测试架构说明（Windows 非 ASCII 路径）

`@cloudflare/vitest-pool-workers` 在 Windows + 非 ASCII 工作区路径下有已知 bug
（[workers-sdk#14655](https://github.com/cloudflare/workers-sdk/issues/14655)，报
`No such module "cloudflare:test-internal"`）。因此本地测试采用：

- **esbuild 打包 worker → Miniflare Node API 加载（真实 workerd + 真实 D1/R2）→ dispatchFetch 真实 HTTP**，
  覆盖认证、权限隔离、版本冲突、同步协议、提醒调度等全部集成场景；
- `vitest.workers.config.ts`（`npx vitest run -c vitest.workers.config.ts`）保留 pool-workers 配置，
  ASCII 路径或 CI 环境可直接使用。

## 目录

```text
src/
  routes/        接口层：路由 + 参数校验 + 权限 + 统一错误
  application/   应用层：作业处理器、实体写入器（在线/离线共用）、同步引擎、提醒调度
  domain/        领域层：规则引擎（纯函数）、状态机、引用核验
  infra/         基础设施：D1/R2、AI 适配器（mock + OpenAI 风格）、提取（unpdf/fflate）、Web Push、Workflows
  shared/        Zod 契约 schema、常量、错误、时间工具
openapi/         契约快照（提交进仓库，前端类型生成来源）
migrations/      D1 迁移（由 schema.ts 生成）
docs/            spike 结论等文档
```

## 环境变量与密钥

`.dev.vars`（本地）与 `wrangler secret`（生产）：

| 变量 | 说明 |
|---|---|
| `SESSION_SECRET` | 会话 Cookie HMAC 密钥（必配） |
| `AI_PROVIDER` | `mock`（默认，确定性假响应）或 `openai` |
| `AI_BASE_URL` / `AI_MODEL` / `AI_API_KEY` | OpenAI 风格接入三件套 |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Web Push 密钥（`npm run generate:vapid` 生成） |
| `VAPID_SUBJECT` | `mailto:you@example.com` |
| `CORS_ORIGIN` | 前端来源白名单（逗号分隔，严禁 `*`） |

wrangler.jsonc vars：`AI_PROVIDER`、`AI_BASE_URL`、`AI_MODEL`、`CORS_ORIGIN`、`DEMO_ENABLED`。

## 模型接入

统一适配器 `src/infra/ai/index.ts`：超时 / 429 / 5xx 指数退避重试；响应一律过项目自身 Zod 校验；
所有模型产出的引用必须命中原文（`domain/quotes.ts`），伪造引用直接拒绝该条目。
`mock` 供应商输出确定性结果且引用必然命中，可用于无密钥开发与测试。

## 分工与验收

- **前端对接文档：[docs/frontend-integration.md](docs/frontend-integration.md)**（接入基础、异步作业、离线同步协议、冲突处理、联调自检清单）
- 组员验收对照表与风险清单见 [backend_plan.md](../backend_plan.md) 八/九/十节；
- 真实环境验证进度见 [docs/deployment.md](docs/deployment.md) 与 [docs/spike-extraction.md](docs/spike-extraction.md)。
