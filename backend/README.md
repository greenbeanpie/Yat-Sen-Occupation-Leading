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

## 账户等级与升级（0005）

- API 身份：`super_admin`（超级管理员）、`admin`（普通管理员）、`student`（一般用户；保留旧名称以兼容既有数据）。演示身份不具备管理权限。
- 以 `COALESCE(users.access_role, users.role)` 为有效权限；历史 `role` 列保留兼容；运行时权限调整会原子更新 `access_role` 及其历史投影（两类管理员对应 `admin`，一般用户对应 `student`），避免历史列保留已撤销的管理员权限。任何新权限检查应使用有效权限，不能直接读取历史列。
- 普通管理员继续维护公共岗位和邀请码，只能查看/修改一般用户的昵称和停用状态；不能调整角色、操作管理员账户或系统设置。
- 超级管理员可以管理角色及邀请注册开关。角色改变对现有会话的下一次请求即时生效；停用会撤销会话且不会删除业务数据。禁止停用当前账户，不能降级/停用最后一位具有登录凭据的有效超级管理员；无法登录的账户不能提升为管理员。角色变更在同一事务写入不含凭据的审计记录。
- `/admin/users` 仅返回必要账户元数据，不返回邮箱、密码哈希或私人求职记录。新增管理写接口要求本站 Origin 与 JSON；不允许通过用户资料修改角色或凭据。
- `0005_account_roles.sql` 为纯增量迁移，不重建用户表、不改变用户名、密码哈希、盐、会话或业务数据。仅把已核验的 `greenbp`（id `b3c4dacf-3562-4938-8ba7-d102f4cffe05`）真实有效管理员升级，其他管理员不会自动升级。
- 发布前核验该账户的 id/用户名/role/is_demo/deleted（不要读取凭据），按顺序应用既有 D1 的待办迁移、发布既有 backend Worker、发布既有 frontend Worker。先确认 migration 成功再发布依赖新列的代码。无需新建 Worker、数据库、Bucket 或任何凭据。

## 支持工单（0006）

真实登录用户可提交文字工单、分页查看/回复自己的工单；普通管理员和超级管理员可处理全部工单并调整状态。演示/游客不可访问，权限改变对后续请求即时生效。工单不赋予任何私人求职数据访问权限。

- `GET /tickets?limit=20&cursor=…`：稳定游标分页，返回 `items` 与 `nextCursor`。
- `POST /tickets`：`{subject,body}`，标题 1–160 字符，正文 1–5000 字符。
- `GET /tickets/{id}?limit=50&before=…`：工单与按时间顺序显示的最新消息；用 `messagesNextCursor` 加载更早消息。
- `POST /tickets/{id}/messages`：`{body}`，工单所有者或管理员回复。
- `PATCH /tickets/{id}/status`：管理员设置 `pending`、`in_progress`、`waiting_user`、`resolved`、`closed`。关闭后禁止回复，管理员可重新打开。

创建限制每账户每 5 分钟 5 次；回复每分钟 20 次；状态修改每分钟 30 次，另受统一请求限制。创建/回复/状态修改要求本站 Origin 与 JSON，严格拒绝所有权及身份字段注入。所有工单响应 `Cache-Control: no-store`，页面仅以纯文字呈现，不写离线缓存，无附件或邮件通知。不要在工单中提交密码、API 密钥、支付凭据等秘密。

### 回滚限制

不要盲目回滚到不支持账户等级的旧后端：旧版本不会检查 `disabled`，可能重新放行已停用账户；旧版本也无法理解超级管理员与普通管理员的边界。若需要回滚，应使用同样执行 `access_role`、`disabled` 和工单访问控制的兼容修复版本，先核验当前权限与迁移状态。不要删除新字段或审计/工单表，不要重置账户或凭据。
