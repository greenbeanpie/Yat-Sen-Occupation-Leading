# 与 PLAN.md 的实施差异

本表以仓库根目录的 [PLAN.md](../PLAN.md) 为验收基准，记录“并入后端 → 重构目录 → 前端接入 → 按计划补齐 → 部署准备”之后的真实状态。只写已检查到的代码与本地验证结果；真实 Cloudflare、真实模型和后台推送另列为待验证，不用本地 mock 结果代替。

## 一、验证基线（全部为本轮实测）

| 项目 | 命令 | 结果 |
|---|---|---|
| 后端类型检查 | `cd backend && npm run typecheck` | 通过 |
| 后端测试 | `cd backend && npm test -- --no-file-parallelism` | 11 个文件 / 56 项通过（Miniflare + 真实 workerd、D1、R2） |
| 前端类型检查 | `cd frontend && npm run typecheck` | 通过 |
| 前端 Lint | `cd frontend && npm run lint` | 通过，0 warning |
| 前端单元测试 | `cd frontend && npm test` | 4 个文件 / 30 项通过（含 19 项演示适配器契约测试） |
| 前端生产构建 | `cd frontend && npm run build` | 通过，生成 `dist/`、Workbox `sw.js` 与 PWA 清单 |
| 部署预检 | `node scripts/deploy-preflight.mjs` | 13 项 PASS / 0 FAIL / 2 项账号侧 TODO（D1、R2 尚未创建） |
| 部署冒烟脚本 | `node backend/scripts/smoke-deploy.mjs http://127.0.0.1:8787` | 9/9 通过（会话、登录 Cookie、画像、登出、OpenAPI） |
| 主流程联调（开发服务器） | `cd frontend && npm run e2e` | 26/26 通过 |
| 主流程联调（生产同构） | `npx wrangler dev -c frontend/wrangler.jsonc -c backend/wrangler.jsonc` + `WORKBENCH_URL=http://127.0.0.1:8790 npm run e2e` | 26/26 通过 |
| 移动端与深链接 | `cd frontend && npm run e2e:responsive`（390×844） | 9/9 通过 |
| 演示模式错误态 | `cd frontend && npm run e2e:demo` | 6/6 通过 |
| 离线编辑后刷新保留内容 | `WORKBENCH_URL=http://127.0.0.1:8790 npm run e2e:offline` | 4/4 通过（外壳走 Service Worker、会话走本机缓存、恢复网络后队列清空） |
| PWA 更新提示 | 两次生产构建 + `npm run preview` + 无头浏览器 | Service Worker 注册、提示出现、点击后生效，3/3 通过 |

“生产同构”指：前端以构建产物由前端 Worker 提供静态资源，`/api/v1/*` 通过 Service Binding 转发到后端 Worker，本地 D1/R2/Workflows 真实运行。这是当前不接触真实 Cloudflare 账号时最接近生产的验证方式。

### 2026-09-30 后端成员在 Windows 上的复验与补测

| 项目 | 结果 |
|---|---|
| 后端测试 | 13 个文件 / 63 项通过；`smoke-deploy.mjs` 对 `127.0.0.1:8787` 9/9 |
| `npm run generate:api` 重新生成 `schema.ts` | 与仓库版本零漂移（前端类型与 OpenAPI 契约一致） |
| 前端单测 | 34 项通过 |
| 主流程 e2e（新增简历上传步骤后） | 28/28 通过：上传 PDF → 解析作业 → 草稿 → 确认写入画像，补齐了此前唯一未覆盖的业务流水线 |
| 访客 / 移动端 / 演示模式 e2e | 5/5、9/9、6/6 通过 |
| 离线刷新 e2e（生产同构 8790） | 4/4 通过。注意：多 worker `wrangler dev` 会忽略 `--persist-to`，D1 状态落在主配置（frontend）目录的 `.wrangler/state` 下，需对该目录执行 `d1 migrations apply --local --persist-to frontend/.wrangler/state`，否则 API 全部 500 |
| 人工浏览器全链路 | 演示身份登录 → 画像 → 经历/技能/引用 → 私人 JD 解析确认 → 匹配 → 组合 → 计划确认与任务推进 → 改写采纳 → 投递/状态机/面试/工时/统计 → 提醒设置 → 管理员发布公共岗位，全部真实往返通过 |

主流程步骤覆盖：画像保存 → 新增经历 → 新增技能 → 建立并确认技能证据引用 → 粘贴私人 JD → 解析并确认岗位要求 → 查看岗位详情 → 生成匹配解释 → 生成求职组合 → 生成两周计划草稿 → 确认计划 → 更新任务状态与实际耗时 → 任务依赖/证据展示 → 生成改写建议 → 创建投递 → 记录工时 → 效率统计 → 推进投递状态 → 断网离线写入 → 离线缓存回显 → 恢复网络同步 → 幂等重复提交 → 提醒设置 → 管理员岗位库 → 演示数据重置。

## 二、分支与目录

- `origin/backend`（`ad79129`）已是 `main` 的历史祖先（`695723b` 为双父合并提交），无需重复合并。
- 目录：`frontend/` 为 React + TypeScript + Vite 应用，早期单文件设计稿归档到 `frontend/prototype/`；`backend/` 保持接口/应用/领域/基础设施四层；跨端文档在 `docs/` 与 `backend/docs/`。

## 三、前端与 PLAN.md 第 4 节对照

| PLAN.md 要求 | 状态 | 证据 |
|---|---|---|
| React + TS + Vite SPA、React Router、响应式布局 | 已实现并验证 | `frontend/src/ui.tsx`、`style.css`；移动端 9/9 |
| 统一数据访问接口 + 演示适配器 + HTTP 适配器 | 已实现 | `frontend/src/api/transport.ts` 按 `VITE_DATA_SOURCE` 选择；演示适配器在 `frontend/src/data/`（19 项测试） |
| 演示适配器模拟延迟、失败、版本变化与冲突，不使用模拟 Service Worker | 已实现 | `demo-transport.ts` 支持延迟/故障注入、409 冲突、opId 幂等、离线抛 `TypeError`；PWA 仍由真实 Workbox 负责 |
| IndexedDB 离线队列、冲突处理、同步中心 | 已实现并验证 | `offline.ts`、`SettingsPage.tsx`；离线写入→缓存回显→幂等同步在 E2E 中通过 |
| PWA 外壳缓存 + 更新提示 | 已实现并验证 | `vite.config.ts`（`registerType: prompt`）、`src/pwa.ts`、`ui.tsx` 的 `UpdateBanner` |
| 通知权限主动申请、拒绝后保留站内提醒 | 已实现（拒绝路径按代码分支，未在浏览器逐条验收） | `platform/browser.ts`、`SettingsPage.tsx` |
| 平台接口隔离（文件选择/通知/网络/本地存储，本轮只实现浏览器适配器） | 已实现 | `frontend/src/platform/`；画像页文件选择与设置页通知/存储已改走该层 |
| 演示数据重置 | 已实现 | 后端 `POST /api/v1/demo/reset`（仅 `DEMO_ENABLED=true`）+ 设置页按钮 + 本机缓存清理 |
| 演示站标明虚构数据 | 已实现 | 登录页、侧栏 `演示站 · 虚构数据`、设置页数据源说明 |
| 固定解析结果只用于配套示例文件 | 已实现并验证 | 非示例文件在演示数据源与后端都明确失败；E2E「解析失败」步骤通过 |
| 计划任务展示岗位/证据/差距/依赖 | 已实现 | 后端生成并存储，前端 `PlanningPage` 渲染「关联岗位 / 已确认证据 / 岗位差距 / 依赖任务」 |
| 旧计划被新计划替代 | 已实现并验证 | 后端 `POST /plans/{id}/confirm` 把其它已确认计划标记 `superseded`；演示适配器同步；E2E 与后端测试均覆盖 |

## 四、后端与 PLAN.md 2.x 对照

| PLAN.md 要求 | 状态与差异 |
|---|---|
| 2.3 跨表写入使用 D1 事务批处理 | 已实现：实体写入、同步回执、计划生成、计划确认与替代均使用 `DB.batch` |
| 2.4 文件处理链与模型适配 | 本地 workerd 下解析/匹配/计划/改写全通；模型默认 `mock`，真实模型 API（超时、限流、错误格式、伪造引用）尚未验证 |
| 2.4 PDF.js + Mammoth | **实现方式不同**：使用 `unpdf` + `fflate` 手工解析 OOXML。Mammoth 依赖 Node 内置模块无法打包进 Workers，理由见 [提取实验](../backend/docs/spike-extraction.md) |
| 2.5 任务依赖、岗位/证据/差距关联 | 已实现：生成器接收岗位差距与已确认证据，写入前逐一校验，`deps_json` 记录前置任务 |
| 2.5 旧计划替代、保留已完成任务 | 已实现：确认新计划时旧计划转为 `superseded`，任务与实际工时保留，并写入变更日志 |
| 2.6 同步协议（opId 去重、版本冲突、墓碑删除、增量变更） | 已实现并通过后端集成测试；浏览器中验证了离线队列、幂等回执与缓存回显 |
| 2.6 真实浏览器推送与定时提醒 | 站内提醒、订阅注册与失效清理已实现；真实 VAPID 推送、后台送达与 cron 触发尚未在真实环境验证 |
| 接口限流 | 未实现；PLAN.md 未列入首版范围，但对公网开放前建议补齐 |

## 五、部署到 Cloudflare 的准备状态

已完成（可复现命令见 [后端部署文档](../backend/docs/deployment.md)）：

- **配置**：后端 `wrangler.jsonc` 已声明 D1、私有 R2、5 个 Workflows、cron 与 observability；前端 `wrangler.jsonc` 更新既有 `greenbp-intern-workbench` Worker，使用自定义域名 `intern.greenbp.dpdns.org`、`assets`（`binding=ASSETS`、SPA 回退、`run_worker_first: ["/api/v1", "/api/v1/*"]`）与 `services: BACKEND → greenbp-intern-workbench-backend`。
- **只读预检**：`node scripts/deploy-preflight.mjs` 跑本地门禁、契约一致性、两个 Worker 的 `wrangler deploy --dry-run`、Cloudflare 登录与 D1/R2 资源状态。
- **资源引导**：`node scripts/bootstrap-cloudflare.mjs --apply` 创建 D1/R2 并回填 `database_id`（默认计划模式，幂等，不写密钥）。
- **CI**：`.github/workflows/ci.yml` 在 push/PR 上执行后端测试与 dry-run、前端 Lint/测试/构建与 dry-run、契约漂移检查。
- **部署后冒烟**：`node backend/scripts/smoke-deploy.mjs <后端地址>`。
- **生产同构验证**：本地用两个 Worker 的 wrangler dev 会话验证了静态资源、SPA 深链接、Service Binding 转发与完整业务流程。

**已完成首次上线（2026-09-30）**：

1. 新建 D1 `yso-db` = `a3a5c86a-d7f7-46f7-b1d1-9440f6ec9322`（APAC）与私有 R2 `yso-docs`，并把真实 `database_id` 回填到 `backend/wrangler.jsonc`；
2. `npm run db:migrate:remote` 应用 `0001_init.sql`（41 条语句）；
3. 写入 `SESSION_SECRET`、`VAPID_PRIVATE_KEY`、`VAPID_SUBJECT` 三个 secret，`VAPID_PUBLIC_KEY` 放入 `vars`；
4. 部署顺序：原位将 `yso-backend` 重命名为 `greenbp-intern-workbench-backend` 并部署，再更新既有 `greenbp-intern-workbench`；意外新建的 `yso-internship-workbench-frontend` 已通过精确 Worker ID 删除。

线上地址与实测：

| 目标 | 地址 | 结果 |
|---|---|---|
| 后端 Worker | <https://greenbp-intern-workbench-backend.hddhp.workers.dev> | 冒烟 9/9；`/api/v1/session` 返回演示身份 |
| 前端 Worker | <https://intern.greenbp.dpdns.org> | Cloudflare API 确认自定义域名、ASSETS 与后端 Service Binding；自动化 HTTP 检查遇到 403 安全挑战，当前线上浏览器流程待复验 |

此前 26 步主流程、移动端深链接 9 步和离线刷新 4 步的验证针对旧的 `yso-internship-workbench-frontend.hddhp.workers.dev` 部署；Worker 已删除，不能作为当前自定义域名的验收结果。后端直连冒烟与本地生产同构验证仍有效。

恢复说明：恢复 `greenbp-intern-workbench` 时 Cloudflare 分配了新的 Worker ID（`6f0068bf09c44ffca500def82538a2a9`），原 Worker ID 与版本历史未保留；自定义域名和后端 Service Binding 已重新挂接。后端 Worker ID 保持为 `ca540dfc662346ef81df95866a6ac5e8`。

## 六、本轮修复的缺陷

1. `input[type=number]` 的 `min=0.1` 配 `step=0.5` 让 8 这类整数非法，浏览器静默拦截提交，保存画像没有任何请求。已改为 `min=0.5`，并让表单在校验失败时显示原因。
2. 表单下拉框没有显式初始值时显示第一项却提交空串，导致“生成两周计划”被服务端以 `Invalid UUID` 拒绝。已默认取首项并补回归测试。
3. 退出登录后登录页拿不到演示身份列表，必须刷新才能重新登录。已改为退出后重新读取 `GET /session`。
4. PWA 更新提示只在已登录布局渲染，刷新后停在登录页时看不到提示。已提取 `UpdateBanner` 并在登录页与工作台同时渲染。
5. 前端 Worker 缺少 `run_worker_first`，`/api/v1/*` 可能被 SPA 回退截获；已显式声明 API 前缀优先交给 Worker，并用本地同构验证确认。
6. eslint 未忽略 wrangler 临时目录，`wrangler dev` 后会误报 lint 错误。已加入忽略列表。
7. 离线刷新会直接回到登录页（`GET /session` 失败即视为未登录），本机缓存内容因此打不开。已改为缓存最近一次会话并在断网时回退使用，离线刷新后可继续编辑与同步。

8.（2026-09-30 复验）`ActionForm` 的下拉框在**选项异步到达**时仍提交空串：初始化只取挂载时的首项，选项后到时 state 停留在 `''` 而 DOM 显示第一项，技能引用创建因此带空 `skillId/experienceId` 被服务端 422 拒绝且界面无报错。已改为提交时取“用户可见的选项值”，覆盖第 2 条未包含的变体。
9.（2026-09-30 复验）匹配分是 0–1 小数，但分项分数卡按 0–100 渲染（87 分显示成 `1 / 100`、进度条近零），组合行直接输出未格式化浮点（`0.8666666666666667`）。已统一按百分制展示。
10.（2026-09-30 复验）管理页“N 项已确认条件”读取列表响应的 `requirements`，而列表接口按契约返回空数组（详情接口才回填），计数恒为 0。已改为在卡片内用详情接口补齐。
11.（2026-09-30 复验）`e2e/playwright-runtime.mjs` 只支持 macOS 的 Chromium 缓存路径且写死版本号，Windows/Linux 直接报“未找到 Chromium”；已改为按平台发现缓存目录并动态解析版本。另：e2e 此前未覆盖简历上传，已补最小 PDF 夹具与断言（26→31 步，含账号注册/凭据登录/演示模式往返）。

12.（2026-09-30 补齐）`login` 表单的 `pattern` 属性在 Chrome 的 `v` 标志下要求转义连字符，`[a-zA-Z0-9_-]{3,32}` 被判为非法正则而静默失效；已改为 `[a-zA-Z0-9_\-]{3,32}`。

## 六之二、本轮新增能力：真实账号体系（PLAN.md 2.1）

| 项目 | 实现 |
|---|---|
| 注册 | `POST /api/v1/session/register`：用户名（3-32 位字母/数字/下划线/连字符，全局唯一）+ 口令（≥8 位），PBKDF2-SHA256（10 万次迭代、随机盐、常数时间比较）存哈希，注册即签发会话并自动登录 |
| 登录 | `POST /api/v1/session/login`：用户名 + 口令；口令错误与用户名不存在返回同一 401 文案，避免账号枚举 |
| 会话 | 复用既有 HMAC HttpOnly Cookie；`SessionResponse.user.demo` 现在区分演示身份（true）与注册账号（false） |
| 迁移 | `backend/migrations/0002_user_credentials.sql`：users 增加 `username`/`password_hash`/`is_demo`，唯一索引 + 存量用户标记为演示身份；`src/infra/db/schema.ts`（测试事实源）同步 |
| 前端 | 登录页为“注册/登录表单 + 演示身份选择 + 游客 + 体验演示模式”；演示模式按钮整页切到内置适配器（sessionStorage 记忆、登出回切正式登录页）；演示数据源下不显示账号表单 |
| 测试 | `backend/test/session-credentials.test.ts` 8 项（注册、登录、重复用户名 422、口令校验、防枚举、登出再登录回路、演示身份不受影响）；e2e 新增“注册并自动进入”“登出后凭据登录”“演示模式往返”三步，主流程 31/31 通过 |

口令强度、注册限流与找回密码未实现；公网部署建议在 Cloudflare 侧加 Rate Limiting 规则，并在真实生产环境设 `DEMO_ENABLED=false` 关闭演示身份入口（演示模式按钮不依赖后端，仍可用）。

## 七、仍未完成或未验证的能力（不得按已完成汇报）

- 真实模型 API：`AI_PROVIDER=openai` 下的格式错误、伪造引用、超时、限流与重试未验证（线上仍为 `mock` 适配器）。
- 浏览器后台推送的真实送达：订阅与失效清理已实现、VAPID 已配置，但未在支持推送的浏览器上验证后台消息与 cron 触发的提醒投递。
- 30 页 PDF 在生产 Workers 上的 CPU/内存实测（本地 workerd 通过，免费额度下的限流未测）。
- 线上仍以 `DEMO_ENABLED=true` 运行：任何访问者都能以演示身份（含演示管理员）登录。真实账号体系已实现（见六之二）；正式生产部署应设 `DEMO_ENABLED=false` 并应用迁移 `0002_user_credentials.sql`。
- 注册与登录未做限流；口令找回、邮箱验证与账号删除界面未实现。
- 两个真实浏览器会话之间的同步冲突选择界面（后端集成测试覆盖协议本身，浏览器内只验证了离线队列与幂等）。
- 通知权限被拒绝的浏览器路径：代码分支存在，但未做逐条验收。
- 接口限流与审计日志脱敏的线上检查。
