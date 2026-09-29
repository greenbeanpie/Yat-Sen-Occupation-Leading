# 后端实施计划（backend_plan.md）

依据 [PLAN.md](./PLAN.md) 第二章「后端程序架构」与第三章「前后端接口契约」制定，指导后端在本仓库 `backend` 分支上的具体实现。本文档只约束后端；与前端相关的接口字段以本文档定义的 OpenAPI 契约为准。

## 一、目标、范围与协作约定

- **目标**：为求职任务工作台 PWA 提供 `/api/v1` JSON API，覆盖画像与证据、文档解析、岗位、匹配与组合、计划与改写、投递与统计、离线同步、通知八个能力域。
- **托管约束**：项目无经费，**全部服务端能力托管在 Cloudflare 免费层**（Workers、D1、R2、Workflows、Cron Triggers）。一切选型不得引入需要自建服务器或付费服务的依赖。
- **分支与目录**：所有后端工作在 `backend` 分支进行，代码放在 `backend/` 目录，由组长合并进 `main`；前端同事在 `webui` 分支的独立目录开发，互不冲突。每次提交前必须 `git branch` 确认当前分支。
- **交付形态**：演示站（虚构数据、演示身份），不包含真实注册认证；不含模拟面试、自动投递、自动发送简历、全网岗位抓取、OCR、Tauri 打包。

## 二、技术选型（Cloudflare 适配）

| 能力 | 选型 | 说明 |
|---|---|---|
| 运行时 | Cloudflare Workers | TypeScript，`nodejs_compat` 兼容标志 |
| HTTP 框架 | Hono v4 | 路由、中间件、CORS |
| 校验与契约 | Zod + @hono/zod-openapi | 同一套 Zod schema 同时做运行时校验和 OpenAPI 生成，是字段唯一来源 |
| 结构化存储 | D1 | SQLite；跨表写入用 `db.batch()` 事务 |
| 文件存储 | R2 私有桶 | 仅通过受控接口访问，不公开桶 |
| 异步任务 | Cloudflare Workflows | 文档解析、匹配解释、计划生成、简历改写四类 |
| 定时任务 | Cron Triggers | 每 15 分钟触发提醒调度 |
| 浏览器推送 | Web Push（VAPID） | 使用 WebCrypto 实现的 `webpush-webcrypto`（或自实现 VAPID 签名 + payload 加密），不用依赖 Node crypto 的 `web-push` |
| 文本提取 | pdfjs-dist（legacy 构建）+ mammoth | 需先在 Workers 环境做兼容性与 CPU 占用 spike（见风险 R1） |
| 模型接入 | 统一 OpenAI 风格适配器 | `AI_PROVIDER=mock|openai`；`AI_BASE_URL`、`AI_MODEL`、`AI_API_KEY` 全配置化；**先实现 mock 供应商**（确定性假响应，支撑开发与测试），真实 API 到位后仅填配置 |
| 测试 | vitest + @cloudflare/vitest-pool-workers | 本地模拟 D1/R2/Workflows；配合 `wrangler dev` 本地联调 |

版本策略：依赖安装时取最新稳定版，锁定在 `package-lock.json`；Zod 主版本以 `@hono/zod-openapi` 兼容要求为准。

## 三、代码结构（四层架构）

```text
backend/
  wrangler.jsonc            # 绑定与配置（D1、R2、Workflows、Cron、vars）
  package.json
  tsconfig.json
  vitest.config.ts
  migrations/               # wrangler d1 migrations
  openapi/
    openapi.json            # 导出的契约快照（提交进仓库，供前端生成类型）
  src/
    index.ts                # 入口：Hono app 组装、scheduled 处理器、Workflow 导出
    routes/                 # 接口层：路由、身份上下文、权限检查、参数校验、统一错误
    application/            # 应用层：组织业务操作与事务（确认画像、生成匹配、采纳计划…）
    domain/                 # 领域层：硬条件、评分、预算分配、状态转换、引用与版本规则（纯函数）
    infra/
      db/                   # D1 访问助手、迁移工具
      r2/                   # 文件存取、受控访问
      ai/                   # OpenAI 风格适配器 + mock 供应商 + 引用核验
      workflows/            # 四个 Workflow 定义
      push/                 # VAPID Web Push 适配器
      logger/               # 脱敏日志
    shared/                 # Zod schema（契约来源）、常量、错误定义
  test/
    unit/                   # 领域规则纯函数测试
    integration/            # D1/R2/同步/权限集成测试
  scripts/
    export-openapi.ts       # 生成 openapi/openapi.json 快照
```

分层铁律（沿用 PLAN.md 2.1）：接口处理器不直接编写评分逻辑；模型适配器不能直接修改学生资料；领域规则全部是可单测的纯函数并带 `rule_version`。

## 四、环境绑定与配置

`wrangler.jsonc` 绑定：

| 名称 | 类型 | 用途 |
|---|---|---|
| `DB` | D1 | 全部结构化数据 |
| `DOCS` | R2 | 简历等原始文件（私有） |
| `PARSE_DOCUMENT` / `GENERATE_MATCH` / `GENERATE_PLAN` / `REWRITE_RESUME` | Workflow | 四类异步作业 |
| Cron | `*/15 * * * *` | 提醒调度 |

变量与密钥（本地 `.dev.vars`，生产用 `wrangler secret`，**一律不入库**）：

- `SESSION_SECRET`：演示会话 Cookie 的 HMAC 密钥
- `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT`：Web Push
- `AI_PROVIDER`（`mock`｜`openai`）、`AI_BASE_URL`、`AI_MODEL`、`AI_API_KEY`
- `CORS_ORIGIN`：允许的前端来源
- `DEMO_ENABLED`：演示身份开关

演示身份：迁移脚本种子数据内置固定演示用户（学生若干、管理员一名）。登录即 `POST /session` 选择演示身份，服务端签发 HMAC 签名 Cookie；角色由服务端数据库决定，**不接受前端自行声明管理员**。此机制仅为演示认证，文档中明确标注不可用于生产。

## 五、数据模型（D1）

通用约定（所有可同步实体）：`id`（UUID）、`user_id`（隔离与权限边界）、`version`（整数乐观锁，每次写 +1）、`deleted`（墓碑标记）、`created_at`/`updated_at`（UTC ISO-8601 文本）。D1 不强制外键，引用完整性由应用层校验 + `db.batch()` 事务保证。

按 PLAN.md 2.3 的七个数据组建表（约 25 张）：

1. **画像与证据**：`users`（角色、时区）、`profiles`（求职目标与偏好、每周时间预算）、`experiences`（经历原文）、`skills`、`experience_skills`（技能↔经历关联 + 原文引用片段与位置 + 确认状态：待确认/已确认/缺少证据）
2. **文档**：`documents`（R2 key、文件名、MIME、大小、页数、状态）、`document_segments`（文本片段 + 来源位置）、`parse_drafts`（解析草稿 JSON、确认状态）
3. **岗位**：`jobs`（公共/私人、来源链接、发布状态）、`job_versions`（JD 版本快照）、`job_requirements`（硬条件及原文引用）
4. **匹配与组合**：`match_snapshots`（输入版本集、`rule_version`、分项评分、差距、引用列表）、`portfolios`、`portfolio_items`（固定/已选、预计准备时间）
5. **计划与改写**：`plans`（版本、草稿/已确认）、`plan_tasks`（预计/实际工时、日期、状态）、`task_dependencies`、`adjustment_suggestions`、`rewrites`（原文对照、逐条采纳状态、引用）
6. **投递与统计**：`applications`（状态：准备中/已投递/面试中/已录用/已拒绝/已撤回）、`application_events`（状态历史）、`interviews`（面试安排）、`time_entries`（实际工时）
7. **平台**：`async_operations`（作业状态与结果）、`sync_operations`（opId 去重回执）、`change_log`（增量同步游标，单调自增 id）、`reminders`（绑定任务版本、触发时间 UTC、渠道、状态）、`push_subscriptions`（endpoint、keys、失效标记）

引用规则（沿用 PLAN.md 2.3）：引用保存来源版本、原文片段及位置；原文修改时相关分析标记过期并保留旧快照，历史解释始终指向当时内容。

## 六、API 契约

统一 `/api/v1` JSON API；Zod schema 同时生成运行时校验与 OpenAPI 文档，`GET /api/v1/openapi.json` 在线提供，`npm run export:openapi` 导出快照提交进 `backend/openapi/openapi.json` 供前端生成类型（跨分支协作的唯一契约通道）。**契约先行**：M1 里程碑即冻结全部路由的字段定义（可实现为桩），交付前端。

路由域与 PLAN.md 第三章一致：

| 域 | 端点要点 |
|---|---|
| `/session` | 登录/登出演示身份；返回当前身份、角色、环境能力（演示模式标记） |
| `/profile`、`/evidence` | 读取、修改、确认、删除；写操作走版本校验 |
| `/documents`、`/operations` | 上传（≤10MB、PDF≤30 页）、启动解析、按 operationId 查询作业状态（queued/running/succeeded/failed）、读取解析草稿、确认入库 |
| `/jobs`、`/admin/jobs` | 公共岗位筛选查询（结构化条件 + 文本搜索）；私人 JD 粘贴与来源链接；管理员新增/编辑/解析确认/发布/下架 |
| `/matches`、`/portfolios` | 创建匹配分析（202）、读取解释（分项评分、差距、准备成本、引用）、生成与修改组合（固定/移除/替换） |
| `/plans`、`/tasks` | 生成两周计划草稿（202）、确认采纳、任务更新、调整建议列表与采纳 |
| `/rewrites` | 创建改写建议（202）、读取原文对照、逐条采纳 |
| `/applications`、`/time-entries` | 投递 CRUD 与状态事件、面试安排、反馈、工时录入、效率统计 |
| `/sync` | 批量提交离线操作、增量变更拉取、冲突处理 |
| `/notifications`、`/push-subscriptions` | 站内提醒列表与已读、推送订阅与取消、提醒开关 |

全局约定：

- 统一错误包络：`{ "error": { "code", "message", "details: [{ field, issue }] } }`，参数错误可定位到字段。
- 耗时操作返回 `202 + { operationId }`；分析类结果必须返回输入版本集与引用列表。
- 在线写入的版本冲突返回 `409 + 当前服务器记录`；普通写入与离线写入经过**同一套**应用层校验。
- 效率统计：按时间范围返回 `获得面试的去重投递数 ÷ 实际工时 × 10`；零工时返回 `data: null` 由前端显示"暂无数据"。
- CORS 仅放行 `CORS_ORIGIN` 配置的前端来源。

## 七、关键机制设计

### 7.1 版本、幂等与冲突

- 乐观锁：更新请求携带 `baseVersion`，不匹配即冲突；在线路径返回 409 + 服务器当前记录，同步路径在批量结果中逐条标记 `conflict` 并附服务器记录，**不得静默覆盖**。
- 增量同步：`change_log` 单调自增 id 作为游标；写路径（在线或离线）一律经应用层，更新、变更日志、操作回执在同一 `db.batch()` 内原子写入。
- 删除一律墓碑；离线编辑遇到远端删除进入冲突处理。
- `sync_operations` 表以 `(user_id, op_id)` 唯一去重，重复提交返回原回执（幂等）。

### 7.2 同步协议端点

- `POST /sync/operations`：批量提交 `{ opId, entity, entityId, baseVersion, payload }`，逐条返回 `applied | duplicate | conflict | rejected`，冲突附服务器版本。
- `GET /sync/changes?since=&entities=`：按游标拉增量（含墓碑）。
- 画像/经历存在未同步修改时，后端对新的匹配/计划请求返回明确错误，前端先同步再请求。

### 7.3 异步作业（Workflows）

四类 Workflow：文档解析、匹配解释、计划生成、简历改写。统一骨架：

1. 记录输入版本集与输入指纹到 `async_operations`；API 侧只创建作业记录并返回 `202 + operationId`。
2. Workflow 逐步骤执行（提取文本 → 模型调用 → 结构校验 → 引用核验 → 落库草稿）；每步持久化，失败有限重试。
3. **写回前核对输入指纹**：旧输入产生的结果不得覆盖新数据；重试幂等（以 operationId 落库）。
4. 失败保留用户输入，`/operations/:id` 返回可重试原因；首版无流式输出。

### 7.4 文件与解析链

处理链固定为：上传 → 提取文本 → 模型提取候选字段 → 结构与引用校验 → 用户确认 → 保存正式数据。

- 上传经 Worker 校验大小/MIME/页数后写入 R2；下载走 `GET /documents/:id/content` 认证流式端点（即"受控短期访问"），不暴露桶、不使用公开 URL。
- PDF 用 pdfjs-dist（legacy）提取有文本层的页面；DOCX 用 mammoth 提取段落；扫描件/加密/无文本明确报错并提供手动录入入口；不做 OCR。
- 解析结果仅为草稿，用户确认后才进入正式画像。

### 7.5 模型适配器与引用核验

- 统一 OpenAI 风格 chat/completions 适配器：只发送必要文本与结构化上下文，绝不发送密钥；超时、429、5xx 指数退避重试；响应一律过项目自身 Zod 校验，不假设供应商支持严格结构化输出或文件理解。
- mock 供应商：返回确定性构造的解析/改写结果（用于开发、测试与无密钥联调），演示站必须能标识其为模拟结果。
- 引用核验：每个引用必须在来源文本（按版本）中精确命中，命中失败直接拒绝该条目；模型新增的数字、成果、无法核验的断言不进入可采纳结果。
- 模型只能产出草稿/候选/解释，**永远不能改写规则分数，不能直接修改学生资料**。

### 7.6 规则引擎（领域层纯函数，`rule_version` 版本化）

- 硬条件三态：满足/不满足/未知；未知不得视为通过；不满足或待核实的岗位不自动进入组合。
- 匹配分：技能覆盖 50% + 已确认证据覆盖 30% + 岗位与行业偏好 20%；偏好缺失时移除该项并归一化，同时返回评分覆盖说明；分数只用于解释排序，不称概率。
- 准备成本 = 关联任务预计耗时汇总，学生可修正；缺估算时不计算单位时间收益。
- 组合选择：按 `匹配分 ÷ 预计准备时间` 排序，在剩余预算内依次选择能于截止日前完成准备的岗位，同分先截止近者；预算不足明确指出，不擅自扩大预算。

### 7.7 计划与投递的状态机

- 计划：草稿 →（学生确认）→ 生效；新反馈/画像修改/任务延期只产生**调整建议**，采纳时再次校验版本；已完成任务及实际工时不可被重新规划删除。
- 投递六状态流转记录 `application_events` 历史；面试机会按投递去重统计。

### 7.8 通知与推送

- Cron 每 15 分钟扫描到期提醒：任务到期日 09:00（按用户时区换算，服务端全 UTC 调度，默认 `Asia/Shanghai`）、面试开始前 1 小时；学生可关闭。
- 提醒绑定任务版本：改期/完成即取消旧提醒；推送带稳定 `Tag` 防重复。
- VAPID Web Push 尽力送达：暂时失败有限重试，404/410 清理失效订阅；站内提醒不依赖推送授权。
- 日志脱敏：不记录简历正文、模型密钥、完整推送订阅内容。

## 八、实施里程碑

| 里程碑 | 内容 | 完成标准 |
|---|---|---|
| M0 准备 ✅ | backend 分支、本文档、.gitignore | 已完成 |
| M1 脚手架与契约先行 | backend/ 工程、wrangler.jsonc、D1 schema v1 迁移、Hono+OpenAPI 骨架、session、统一错误、CORS、openapi.json 快照、**PDF/DOCX 提取 spike** | `npm run typecheck`/`test` 通过；openapi.json 可供前端生成类型；spike 结论写入文档 |
| M2 画像与文档 | profile/evidence CRUD + 版本；文档上传、解析 Workflow、草稿确认；operations 查询 | 本地完成"上传→解析→确认入库"全链路 |
| M3 岗位与匹配 | 私人岗位 + 管理员公共岗位、权限中间件；规则引擎；匹配 Workflow；组合 | 规则引擎单测全绿；权限隔离测试通过 |
| M4 计划与跟踪 | 计划/任务/调整建议、改写建议、投递/事件/面试/工时、效率统计 | 状态机与"已完成任务不可删除"测试通过 |
| M5 同步与通知 | 同步协议全套、增量拉取、冲突；提醒、Cron、Web Push | 双客户端同步/幂等/冲突测试通过；本地推送验证 |
| M6 加固与交付 | 日志脱敏、部署配置与操作文档、真实环境验证、验收对照表、未完成项清单 | PLAN.md 组员验收逐条核销或标记待办 |

## 九、测试与验收对照

| PLAN.md 组员后端验收 | 验证方式 |
|---|---|
| PDF/DOCX 文本提取在真实 Cloudflare 环境通过 | M1 spike + M6 真实部署后用样例文件验证（账号到位后执行） |
| 模型响应格式错误、伪造引用、超时、限流、重试正确处理 | mock 供应商注入故障的集成测试 + 引用核验单测 |
| 两客户端增量同步、幂等提交、冲突解决 | vitest-pool-workers 集成测试模拟两用户交错提交 |
| 私人岗位隔离、管理员权限、未授权文件访问 | 集成测试：跨用户 404/403 断言 |
| 真实订阅、后台推送、取消提醒 | M6 真实环境验证（账号到位后执行） |
| 迁移与日志合规 | 迁移脚本演练 + 日志内容审查清单 |

## 十、风险与对策

| # | 风险 | 对策 |
|---|---|---|
| R1 | **Workers 免费版单请求 CPU 约 10ms，PDF 解析可能超限**（首要风险） | M1 即在真实环境实测（账号到位前先用本地 wrangler dev 评估）；预案：Workflow 分页拆步、收紧页数；若实测仍不可行，尽早向组长上报（备选：升级付费 / 前端浏览器内提取文本后上传，后者需前端配合，须早期决策） |
| R2 | mammoth/pdfjs 与 Workers 运行时不兼容 | spike 先行；DOCX 备选方案：解压后直接解析 `word/document.xml` |
| R3 | `web-push` 依赖 Node crypto 不可用 | 改用 WebCrypto 系实现（`webpush-webcrypto` 或自实现，约 200 行） |
| R4 | D1 外键不强制 | 应用层校验 + `db.batch()` 事务，关键路径加集成测试 |
| R5 | Cloudflare 账号未到位，真实环境验收空缺 | 本地 vitest-pool-workers + wrangler dev 覆盖开发验证；交付部署配置与操作文档；未完成项清单明确标记，账号到位后补验 |
| R6 | 跨分支契约漂移 | openapi.json 快照随契约变更提交进 backend 分支；前端仅以快照生成类型 |

## 十一、交接物

后端源码（backend 分支）、OpenAPI 契约快照、D1 迁移脚本、wrangler 部署配置与操作文档（含 secrets 设置清单）、测试结果、演示用样例简历文件、未完成项清单（真实环境验证待账号）。
