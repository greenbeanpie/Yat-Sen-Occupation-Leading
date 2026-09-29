# 部署指南与验收状态（M6）

本文档是 Cloudflare 部署与发布的操作入口。命令默认在仓库根目录执行，标注 `cd` 的除外。
首次部署按第 0 → 7 节顺序执行；日常发布只需第 1、5、6 节。

## 0. 现状与前置条件

2026-09-30 部署结果（已完成首次上线）：

- 账号 `17a6817bca6612a9cb11d0395eeba0ac`（`zgpride87@outlook.com`）；
- D1 `yso-db` = `a3a5c86a-d7f7-46f7-b1d1-9440f6ec9322`（APAC），已应用 `0001_init.sql`；
- R2 私有桶 `yso-docs` 已创建；`backend/wrangler.jsonc` 已回填真实 `database_id`；
- 后端 Worker：<https://yso-backend.hddhp.workers.dev>；
- 前端 Worker：<https://yso-internship-workbench-frontend.hddhp.workers.dev>（Service Binding 指向 `yso-backend`）；
- Secrets：`SESSION_SECRET`、`VAPID_PRIVATE_KEY`、`VAPID_SUBJECT` 已写入后端 Worker；`VAPID_PUBLIC_KEY` 在 `vars` 中；
- 本机 Node `v26.3.0`、wrangler `4.44.0`；CI 使用 Node 22。

上线后实测：后端冒烟 9/9；线上前端主流程 26/26（含真实 Workflows、D1、Service Binding）；
移动端与深链接 9/9；离线刷新与恢复同步 4/4。

再次发布只需第 1、5、6 节；第 2～4 节仅在新账号或重建环境时执行。

前置条件：Cloudflare 账号具备 Workers、D1、R2、Workflows 权限；本机执行过
`cd backend && npx wrangler login`。

## 1. 一键预检（只读）

```bash
node scripts/deploy-preflight.mjs
```

脚本依次执行：后端 `typecheck` + 测试、前端 `typecheck` + Lint + 测试 + 生产构建、
OpenAPI 快照与前端生成类型的一致性、两个 Worker 的 `wrangler deploy --dry-run`，
最后只读查询 Cloudflare 登录状态与 D1/R2 资源。输出含义：

| 标记 | 含义 |
|---|---|
| `PASS` | 已验证通过 |
| `FAIL` | 必须修复，脚本以非 0 退出 |
| `TODO` | 账号侧待办（创建资源、回填 id 等），不阻塞本地结论 |
| `WARN` | 需要人工确认但不一定是错误 |

参数：`--quick` 跳过测试、构建与契约再生成；`--strict` 让账号侧 TODO 也判定为失败，
适合正式发布前使用。脚本不会创建资源、写入密钥或部署。

仓库 CI（`.github/workflows/ci.yml`）在 push / PR 上执行同样的门禁：后端测试与 dry-run、
前端 Lint/测试/构建与 dry-run、契约快照漂移检查。

## 2. 创建 Cloudflare 资源（一次性）

```bash
node scripts/bootstrap-cloudflare.mjs          # 计划模式：只打印将要执行的操作
node scripts/bootstrap-cloudflare.mjs --apply  # 创建 D1 yso-db、R2 yso-docs 并回填 database_id
```

脚本幂等：资源已存在时跳过创建，只校正 `backend/wrangler.jsonc` 的 `database_id`；不会写入密钥。

手动等价操作（需要时备查）：

```bash
cd backend
npx wrangler d1 create yso-db      # 记下 database_id，替换 wrangler.jsonc 的 REPLACE_AFTER_D1_CREATE
npx wrangler r2 bucket create yso-docs
```

## 3. 应用远端迁移

```bash
cd backend
npm run db:migrate:remote
```

迁移脚本来自 `migrations/0001_init.sql`（由 `npm run gen:migrations` 生成）。迁移只前进不回滚；
重新部署旧代码不会回退表结构。

## 4. Secrets 与环境变量

| 变量 | 位置 | 说明 |
|---|---|---|
| `SESSION_SECRET` | secret（必填） | 会话 Cookie HMAC 密钥，用 `openssl rand -hex 32` 生成 |
| `VAPID_PRIVATE_KEY` | secret（推送必填） | `npm run generate:vapid` 输出的 privateKey |
| `AI_API_KEY` | secret（`AI_PROVIDER=openai` 时必填） | 模型服务密钥；mock 模式不需要 |
| `VAPID_PUBLIC_KEY` / `VAPID_SUBJECT` | `wrangler.jsonc` vars 或 secret | 公钥非敏感；subject 形如 `mailto:you@example.com` |
| `AI_PROVIDER` / `AI_BASE_URL` / `AI_MODEL` | `wrangler.jsonc` vars | 默认 `mock`；切真实模型需三件套齐全 |
| `CORS_ORIGIN` | `wrangler.jsonc` vars | 逗号分隔白名单，禁止 `*`；建议部署前端后改为前端 Worker 域名 |
| `DEMO_ENABLED` | `wrangler.jsonc` vars | 演示站保持 `true`；演示身份不可用于生产认证 |

```bash
cd backend
openssl rand -hex 32 | npx wrangler secret put SESSION_SECRET
npm run generate:vapid                # 公钥填入 wrangler.jsonc vars；私钥执行下一条
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler secret list              # 只读核对已配置的密钥名
```

`.dev.vars` 只服务本地开发，已被 `.gitignore` 忽略；不要提交任何密钥。

## 5. 部署

先部署后端，再部署前端：前端的 `BACKEND` Service Binding 按名称绑定 `yso-backend`，
同源 `/api/v1/*` 因此保持会话 Cookie 同源。

```bash
cd backend
npm run deploy
# Workflows 首次部署后自动注册；Cron 在 wrangler.jsonc 声明（*/15 * * * *）

cd ../frontend
npm run deploy        # 先生产构建，再部署静态资源 Worker
```

首次前端部署后建议把前端 Worker 域名写入后端 `CORS_ORIGIN`（同源 Service Binding 不依赖它，
但直连后端调试或未来增加跨域客户端时需要），然后重新部署后端：

```bash
cd backend
npx wrangler deploy
```

## 6. 部署后冒烟

```bash
node backend/scripts/smoke-deploy.mjs https://yso-backend.<subdomain>.workers.dev
```

脚本检查：会话列表与 demoMode 能力 → 演示身份登录（签发 Cookie）→ 带 Cookie 读取身份 →
画像接口 → 登出 → OpenAPI 文档；全部通过才退出 0。也可指向本地 `npm run dev`
（`http://127.0.0.1:8787`）作为脚本自检。

手动等价操作：

```bash
curl https://<worker-domain>/api/v1/session
curl -X POST https://<worker-domain>/api/v1/session -H 'Content-Type: application/json' \
  -d '{"userId":"10000000-0000-4000-8000-000000000001"}'
```

## 7. 更新与回滚

- 更新：重新执行第 1、5、6 节；后端 `wrangler deploy` 会生成新版本，前端每次部署都是新版本。
- 回滚代码：`cd backend && npx wrangler rollback`（仅回退 Worker 版本，不回退 D1 表结构与 R2 数据）；
  前端回滚需要重新部署旧提交的构建产物。
- 迁移与日志：日志由 `observability.enabled` 打开，白名单脱敏，不记录简历正文、模型密钥或完整推送订阅；
  用 `npx wrangler tail` 观察线上请求。

## 8. 验收状态（PLAN.md「组员后端验收」）

| 验收项 | 状态 | 说明 |
|---|---|---|
| PDF/DOCX 文本提取在实际 Cloudflare 环境运行通过 | ⏳ 待首次部署 | 本地真实 workerd（Miniflare）已通过（[spike 文档](spike-extraction.md)）；真实环境待复测 CPU/内存（R1） |
| 模型响应格式错误、伪造引用、超时、限流和重试得到正确处理 | ✅ 本地通过 | mock 供应商 + 引用核验 + OpenAI 适配器重试逻辑（单元/集成测试覆盖）；真实 API 联调待密钥 |
| 两个真实客户端完成增量同步、幂等提交与冲突解决 | ✅ 本地通过 | 双会话交错编辑测试（test/sync.test.ts）；真实双设备待复测 |
| 私有岗位隔离、管理员权限及未授权文件访问 | ✅ 本地通过 | 跨用户 404/403、角色检查、R2 内容仅本人可读 |
| 真实订阅、后台推送和取消提醒 | ⏳ 部分 | 订阅 CRUD、提醒排期/取消/Cron tick 本地通过；真实浏览器推送需线上 VAPID 配置后验证 |
| 迁移与日志；日志不记录简历正文、模型密钥或完整推送订阅 | ✅ | 迁移脚本化（schema.ts → migrations）；logger 白名单脱敏 |

## 9. 未完成项清单

1. **首次真实部署与验证**（上表 ⏳ 项）——按第 1 → 6 节执行，并把结果回填本文件。
2. **真实模型 API 联调**——`AI_PROVIDER=openai` + 三件套配置；当前 mock 供应商行为与真实 API 的差异需一轮联调（提示词对齐、JSON 稳定性）。
3. **R1 CPU 风险复测**——30 页 PDF 在免费档 10ms CPU 限制下实测；若超限启用分页拆步预案（代码已按步骤化 Workflow 组织，拆分成本低）。
4. **计划再生成（superseded）**——旧计划保留但「重新生成」入口未做管理端点；当前以多次生成 + 采纳最新实现。
5. **限流**——未实现速率限制（演示范围外，Cloudflare WAF 可选做）。
6. **`.dev.vars` 分发**——SESSION_SECRET 等由部署者自行生成，不入库。
