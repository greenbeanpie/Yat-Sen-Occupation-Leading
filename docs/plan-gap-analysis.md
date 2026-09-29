# 与 PLAN.md 的实施差异

本表以仓库根目录的 [PLAN.md](../PLAN.md) 为验收基准，记录本轮“并入后端 → 重构目录 → 前端接入 → 验证”之后的真实状态。只写已检查到的代码与本地验证结果；真实 Cloudflare、真实模型和后台推送另列为待验证，不用本地 mock 结果代替。

## 一、本轮验证基线

| 项目 | 命令 | 结果 |
|---|---|---|
| 后端类型检查 | `cd backend && npm run typecheck` | 通过 |
| 后端测试 | `cd backend && npm test -- --no-file-parallelism` | 10 个文件 / 53 项通过（Miniflare + 真实 workerd、D1、R2） |
| 前端类型检查 | `cd frontend && npm run typecheck` | 通过 |
| 前端 Lint | `cd frontend && npm run lint` | 通过，0 warning |
| 前端单元测试 | `cd frontend && npm test` | 2 个文件 / 6 项通过 |
| 前端生产构建 | `cd frontend && npm run build` | 通过，生成 `dist/` 与 Workbox `sw.js` |
| 前端部署配置 | `cd frontend && npx wrangler deploy --dry-run` | 通过，绑定 `env.BACKEND`(service) 与 `env.ASSETS`(assets) |
| 端到端联调 | `cd frontend && npm run e2e`（脚本见 [frontend/e2e](../frontend/e2e/README.md)） | 24/24 步骤通过 |
| 移动端与深链接 | `cd frontend && npm run e2e:responsive`（390×844 视口 + `/plan` 直接刷新） | 9/9 通过 |

端到端步骤覆盖：画像保存 → 新增经历 → 新增技能 → 建立并确认技能证据引用 → 粘贴私人 JD → 解析并确认岗位要求 → 查看岗位详情 → 生成匹配解释 → 生成求职组合 → 生成两周计划草稿 → 确认计划 → 更新任务状态与实际耗时 → 生成改写建议 → 创建投递 → 记录工时 → 效率统计 → 推进投递状态 → 断网离线写入 → 离线缓存回显 → 恢复网络同步 → 幂等重复提交 → 提醒设置 → 管理员岗位库。

## 二、分支与目录

- `origin/backend`（`ad79129`）已经是 `main` 的历史祖先：`695723b` 是以 `fe90e1e` 和 `ad79129` 为父提交的合并提交，因此本轮无需再次合并，只在其后补齐了后端修复提交。
- 目录重构已完成：`frontend/` 是 React + TypeScript + Vite 应用，早期单文件设计稿归档到 `frontend/prototype/`；`backend/` 保持接口/应用/领域/基础设施四层；跨端文档集中在 `docs/` 与 `backend/docs/`。

## 三、前端与 PLAN.md 第 4 节的对照

| PLAN.md 要求 | 实现情况 | 证据 |
|---|---|---|
| React + TypeScript + Vite 响应式 SPA，React Router 路由 | 已实现，8 个页面路由 + SPA 深链接回退 | `frontend/src/ui.tsx`、`frontend/vite.config.ts`、`frontend/wrangler.jsonc` |
| IndexedDB（Dexie）离线队列与缓存 | 已实现，队列按账号隔离，含冲突表与同步游标 | `frontend/src/offline.ts` |
| Service Worker / Workbox PWA 外壳 | 已实现，构建生成 `sw.js` 与 9 个预缓存条目 | `frontend/vite.config.ts` 的 `VitePWA` 配置 |
| 页面：工作台 / 画像与证据 / 岗位 / 匹配与组合 / 计划 / 投递跟踪 / 管理员 / 设置与同步 | 8 个页面均已实现并接通 `/api/v1` | `frontend/src/pages/*.tsx` |
| 默认中文、浅色工作台风格、桌面侧栏 + 移动端底部导航 | 已实现，390×844 视口逐页无横向溢出 | `frontend/src/style.css` |
| 耗时操作返回 `202 + operationId`，前端查询进度 | 已实现（解析、岗位要求、匹配、计划、改写五条链路） | `frontend/src/api/client.ts` 的 `pollOperation` |
| 离线冲突展示两个版本并由学生选择 | 已实现冲突卡片与“采用服务端 / 保留并重新提交” | `frontend/src/pages/SettingsPage.tsx` |
| 通知：用户主动开启后才请求权限，拒绝时保留站内提醒 | 已实现；订阅失败、权限被拒、缺 VAPID 公钥都会降级提示 | `SettingsPage.tsx` 的 `subscribePush` |
| 统一数据访问接口，提供“演示适配器 + HTTP 适配器” | **未按计划实现**：只有 HTTP 适配器，没有本地演示适配器；演示能力由后端 `DEMO_ENABLED` 提供 | `frontend/src/api/client.ts` |
| 演示站始终标明虚构数据 | 已实现：登录页、侧栏与页脚均标注 | `ui.tsx` 的 `.demo-banner` 与页脚 |
| 固定解析结果只能用于配套示例文件 | 已满足：任意上传文件都走服务端真实解析，前端未内置假结果 | `ProfilePage.tsx` 的 `submitResume` |
| 设置与同步中心：安装说明、冲突处理、演示数据重置 | 安装说明与冲突处理已实现；**演示数据重置没有后端接口**，页面如实说明只能切换身份并清理本机队列 | `SettingsPage.tsx` 的“安装与演示数据” |

## 四、实现方式与计划不同（需登记）

| PLAN.md 写法 | 实际实现 | 说明 |
|---|---|---|
| PDF 用 PDF.js，DOCX 用 Mammoth | `unpdf` + `fflate` 手工解析 OOXML | Mammoth 依赖 Node 内置模块，无法打包进 Workers；实验记录见 [提取实验](../backend/docs/spike-extraction.md)。计划文本本身尚未同步修改。 |
| 计划任务包含依赖、关联岗位与证据/差距 | 任务主要按已选岗位标题生成，`deps_json` 恒为空数组，`evidence_id`/`gap` 未被写入 | `backend/src/application/generate-plan.ts`；数据库列已存在，属于未完成而非设计变更。 |
| 旧计划被新计划正式替代 | 计划表有 `superseded` 状态，但没有接口会把计划置为该状态 | 目前只能生成新草稿，缺少“替代旧计划并保留已完成任务”的接口闭环。 |
| 前端演示适配器模拟延迟、失败与版本冲突 | 未实现，演示能力由后端 demo 身份 + mock 模型提供 | 若要脱离后端演示，需要补一层适配器。 |

## 五、接入过程中修复的前端缺陷

这三处都会让用户“点了没反应”，只有在浏览器联调中才会暴露：

1. `input[type=number]` 的 `min=0.1` 与 `step=0.5` 组合让 8 这类整数不合法（步长基准取 `min`），浏览器静默拦截提交，保存画像不发出任何 PUT 请求。已把每周时长、准备预算与预计小时的 `min` 调整为 `0.5`，并让表单在校验失败时显示可见提示（`frontend/src/components.tsx`、`pages/ProfilePage.tsx`、`pages/MatchingPage.tsx`、`pages/PlanningPage.tsx`）。
2. 表单下拉框没有显式初始值时，界面显示第一个选项但状态是空串，导致“生成两周计划”提交 `portfolioId: ""` 并被服务端以 `Invalid UUID` 拒绝。已改为默认取第一个选项的值，并补了回归测试（`frontend/src/forms.ts`、`frontend/src/forms.test.ts`）。
3. 退出登录后只把会话对象置空，登录页拿不到服务端返回的演示身份列表，必须刷新页面才能重新登录。已改为退出后重新读取 `GET /session`（`frontend/src/ui.tsx`）。

## 六、后端与计划要求之间仍然存在的差异

| PLAN.md 要求 | 当前实现与差异 | 影响或后续验证 |
|---|---|---|
| 2.4：文件处理链与模型适配 | 本地 workerd 下解析、匹配、计划、改写均通过；`AI_PROVIDER=mock` 为确定性适配器 | 真实 OpenAI 风格模型 API（超时、限流、错误格式、伪造引用）尚未验证 |
| 2.5：计划任务依赖与证据关联 | 见第四节 | 计划页目前不能把依赖和证据关联当作已完成能力呈现 |
| 2.5：旧计划替代流程 | 见第四节，部署文档同样将其列为未完成 | 需要在接口层补齐替代与保留已完成任务 |
| 2.6：跨设备离线同步与冲突解决 | `/sync` 协议、opId 去重、墓碑删除、版本冲突均有实现与集成测试；本轮又在浏览器中验证了离线队列、缓存回显与重复提交返回 `duplicate` | 两个真实浏览器会话之间的冲突选择尚未端到端演示 |
| 2.6：真实后台推送与定时提醒 | 站内提醒、订阅注册与失效清理已实现 | 真实 VAPID 订阅、后台推送与定时触发仍待真实环境验证 |
| 5：真实 Cloudflare 环境验收 | 仅完成本地 Miniflare/workerd 与部署配置校验 | 生产 D1/R2/Workflows、30 页 PDF 的 CPU 限流、线上日志需实测，见 [部署记录](../backend/docs/deployment.md) |
| 接口限流 | 未实现 | PLAN.md 未把限流列入首版范围，但演示站对公网开放时应补 |

## 七、尚未验证或尚未实现的能力（不得按已完成汇报）

- 真实模型 API、生产 D1/R2/Workflows、浏览器后台推送与定时提醒。
- 两个真实浏览器会话之间的同步冲突选择界面（后端集成测试覆盖协议本身）。
- 解析失败、引用缺失、硬条件未知、岗位下架、旧计划过期、零工时统计等错误态在浏览器中的逐项走查：页面均有对应分支与提示，但没有逐条执行验收步骤。
- 前端“演示适配器”与演示数据重置接口。
- 仓库没有 CI 配置，`frontend/` 与 `backend/` 的检查需要手动执行。
