# 前端对接文档（Frontend Integration Guide）

面向仓库 `frontend/` 中的 PWA 对接后端 `/api/v1` 的说明。字段定义的**唯一权威来源**是 OpenAPI 契约：`backend/openapi/openapi.json`（快照，随契约变更提交）或线上 `GET /api/v1/openapi.json`。本文档解释契约之外的行为约定、状态机和时序。

## 1. 接入基础

### 1.1 环境与 CORS

| 环境 | Base URL |
|---|---|
| 本地联调 | `http://127.0.0.1:8787/api/v1`（后端 `npm run dev`） |
| 部署后 | `https://<worker 域名>/api/v1` |

- CORS 是**严格白名单**（后端 `CORS_ORIGIN` 变量），默认只放行 `http://localhost:5173`；联调前把前端地址发给后端组员配置。
- 会话使用 Cookie（`HttpOnly; SameSite=Lax`），所有请求必须带凭据：

```ts
fetch(url, { credentials: "include", ... });
```

### 1.2 类型生成（契约先行）

```bash
cd frontend
npm run generate:api
```

契约更新流程：后端改字段 → 在 `backend/` 运行 `npm run export:openapi` → 提交契约快照 → 在 `frontend/` 重新生成。前端**不要手写接口类型**。

### 1.3 统一错误包络

所有非 2xx 响应都是同一形状，`details` 可定位到字段，`server` 仅在 409 出现（服务器当前记录）：

```json
{
  "error": {
    "code": "version_conflict",
    "message": "记录已被其他修改更新，请先查看服务器版本",
    "details": [{ "field": "title", "issue": "该字段为必填" }],
    "server": { "id": "...", "version": 3, "...": "服务器当前记录" }
  }
}
```

| code | HTTP | 前端处理 |
|---|---|---|
| `unauthorized` | 401 | 跳登录（演示身份选择页） |
| `forbidden` | 403 | 提示无权限（学生访问管理员功能等） |
| `not_found` | 404 | 资源不存在**或无权查看**（隐私隔离统一用 404，不泄露存在性） |
| `version_conflict` | 409 | 冲突处理：展示 `error.server` 与本地版本对比，用户选择后带新 baseVersion 重试 |
| `sync_required` | 409 | 本地有未同步修改：先走同步流程，再重试原请求 |
| `invalid_request` | 422 | 按 `details[].field` 标红表单项 |
| `quote_rejected` | 422 | 引用未命中原文：提示用户核对原文（计划书要求，不可绕过） |
| `unprocessable_file` | 422 | 文件类型/大小/页数/无文本层；提示手动录入入口 |
| `operation_failed` / `internal_error` | 500 | 展示可重试提示 |

### 1.4 通用字段约定

可同步实体统一带：`id`（UUID）、`userId`、`version`（整数乐观锁，**每次写 +1**）、`deleted`（墓碑布尔）、`createdAt`、`updatedAt`。任何更新请求都必须携带读到的 `version` 作为 `baseVersion`。

## 2. 会话与演示身份

```
GET    /session     当前身份；未登录时附带可用演示身份列表与能力位
POST   /session     {userId} 登录（服务端签发 Cookie）
DELETE /session     登出（204）
```

未登录响应（登录页数据源）：

```json
{
  "authenticated": false,
  "demoUsers": [{ "id": "...", "role": "student|admin", "displayName": "演示学生" }],
  "capabilities": { "push": false, "offline": true, "demoMode": true }
}
```

要点：

- **角色由服务端决定**（数据库），前端不能也不需要声明管理员；按 `user.role` 控制管理员页面入口。
- `capabilities.push=false` 表示后端未配置 VAPID：隐藏推送开关，仅保留站内提醒。
- `capabilities.demoMode=true` 时，界面须持续标明「演示站 · 虚构数据」（计划书要求）。

## 3. 异步作业模式（202 + 轮询）

耗时操作（解析、匹配解释、计划生成、简历改写、岗位要求解析）一律返回：

```
202 { "operationId": "..." }
```

轮询：`GET /operations/:id` →

```json
{ "id": "...", "type": "parse_document", "status": "succeeded", "error": null, "resultRef": "..." }
```

- `status`: `queued → running → succeeded | failed`。建议轮询间隔 1.5s，指数退避到 5s 封顶。
- **成功后用 `resultRef`** 取结果：解析草稿（`GET /documents/:id/draft`）、匹配快照（`GET /matches/:id`）、计划（`GET /plans/:id`）、改写（`GET /rewrites/:resultRef`）。
- 失败时 `error` 是**给用户看的可重试原因**；用户输入已被保留，直接允许「重试」（重新 POST 同一创建端点）。
- 无流式输出（首版约定）。

## 4. 功能域速览

以下只列**行为要点**，字段细节以契约为准。

### 4.1 画像 `/profile`

- `GET /profile`：无画像时返回**空壳**（`id: ""`、`version: 0`），表单按空值渲染。
- `PUT /profile`：首次提交可不带 `baseVersion`；之后必须带。冲突 409 + `error.server`。
- 画像修改会使既有匹配快照**读取时标记 `stale`**（见 4.4）。

### 4.2 证据 `/evidence`

- `GET /evidence` → `{experiences, skills, links}` 一次取全。
- 证据关联（links）三态：`pending`（待确认）→ `confirmed`（已确认）/`missing_evidence`。**匹配分只认 confirmed**，界面上要把三态做明显区分（计划书：不把模型推断当事实）。
- 创建 link 时 `quote` 必须是经历 `description` 的原文子串（允许空白差异），否则 `422 quote_rejected`。建议前端在选择引用时就地高亮原文。

### 4.3 文档 `/documents`

- `POST /documents`：`multipart/form-data`，字段名 `file`；限 PDF/DOCX、10MB、PDF 30 页；扫描件/无文本层返回 422 并提示手动录入。
- 流程：上传 201 → `POST /documents/:id/parse` 202 → 轮询 → `GET /documents/:id/draft` 展示草稿 → 用户确认 `POST /documents/:id/confirm`（`{confirm:true}`）。
- 确认后经历/技能入库、证据关联一律 `pending`，引导用户去确认页面逐条确认。
- 文件本体只有所有者可读：`GET /documents/:id/content`（二进制流）。列表接口不含正文。

### 4.4 岗位 `/jobs`、管理员 `/admin/jobs`

- `GET /jobs?scope=public|mine&q=&degree=&location=`；**列表返回的 `requirements` 恒为空数组**，详情 `GET /jobs/:id` 才含当前版本硬条件。
- 私人 JD：学生 `POST /jobs`（草稿态）；编辑 `PUT /jobs/:id` 需 `baseVersion`；**JD 文本变更会 `jobVersion+1` 并清空已确认要求**，前端要提示重新解析。
- 要求解析确认流：`POST /jobs/:id/parse-requirements` 202 → `GET /jobs/:id/requirements-draft`（候选列表，每条带原文引用）→ 用户勾选 → `POST /jobs/:id/requirements/confirm`。
- 发布：管理员 `POST /admin/jobs/:id/publish` `{action: publish|archive|unpublish}`；`archived`/未发布的公共岗位对学生 404。
- 硬条件类型：`degree`（associate<bachelor<master<phd）、`graduation_year`、`location`、`skill`、`experience`、`other`。

### 4.5 匹配 `/matches` 与组合 `/portfolios`

- `POST /matches {jobId, clientProfileVersion?, clientExperienceVersions?}` → 202。**若客户端版本领先服务端 → 409 `sync_required`**（见第 6 节）。
- 快照对象：`hardConditions[]`（`met/unmet/unknown` 三态，**unknown 不能当通过展示**）、`scores{skillCoverage, evidenceCoverage, preference, total, coverageNote}`、`gaps[]`、`explanation{summary, advantages, gaps, prepSuggestions, rejectedQuotes}`、`quotes[]`。
- `status` 可能为 **`stale`**（画像/经历在分析后变过）：界面必须显示「已过期，建议重新分析」，但保留旧解释可查看。
- **分数只用于解释与排序，严禁包装成「录取概率」**（计划书红线）。
- 组合：`POST /portfolios {timeBudgetHours, pinnedJobIds?, removedJobIds?}` 同步返回计算结果；`PUT /portfolios/:id` 是**全量语义**（pinned/removed 传完整列表）。
- `items[]` 每项：`selected`、`excludedReason: budget|deadline|hard_conditions|null`、`unitBenefit`（无估算时 null，此时按分数排序）。`notes.pinnedWarning` 有值时提示「固定岗位未能全部进入组合」；`notes.remainingBudget` 展示剩余预算。**预算不足要明说，前端不得提供"偷偷扩大预算"的默认行为**。

### 4.6 计划 `/plans`、任务 `/tasks`

- `POST /plans {portfolioId}` → 202 → 草稿（`status: draft`）。**生成与采纳是两个动作**：用户确认 `POST /plans/:id/confirm` 才生效。
- confirm 若返回 409：生成后画像/经历变过，提示重新生成。
- `PATCH /tasks/:id {baseVersion, ...}` 返回 `{task, suggestionId}`；状态机 `pending → in_progress → done`（可 `cancelled`，done 为终态）。**已完成任务与实际工时永不消失**，重新生成计划是新建，不是覆盖。
- 确认后的计划在任务**延期**或**实际工时超预估 50%** 时产生 `suggestionId`；`GET /plans/:id/suggestions` 查看，`POST /suggestions/:id/resolve {action: accept|reject}` 处理。建议**不自动应用**，前端要给出明确的采纳/驳回操作。

### 4.7 改写 `/rewrites`

- `POST /rewrites {experienceId}` → 202 → `GET /rewrites/:id`，`items[]` 为「原文引用 ↔ 建议」对照，逐条 `POST /rewrites/:id/items/:itemId/resolve {action}`。
- **accept 会把建议文本写回经历原文**（经历 version+1，相关分析转 stale）；若原文已被改过 → 409 `version_conflict`，需刷新后重试。
- 后端保证建议不含未确认的数字/成果；前端不需要再做事实校验，但要保留原文对照展示（计划书要求）。

### 4.8 投递 `/applications`、工时 `/time-entries`

- 状态机：`preparing → submitted → interviewing → offered | rejected`；多数状态可 `withdrawn`；非法流转返回 422（前端按 422 的 details 提示，或本地先做同款校验）。
- `PATCH /applications/:id` 与 `POST /applications/:id/events {type:"status_change", toStatus}` 都能流转，事件全部留痕（`GET /applications/:id/events`），状态历史 UI 从事件渲染。
- 面试：`POST /applications/:id/interviews {scheduledAt(UTC ISO), stage?, locationOrLink?}`；改期 `PATCH /interviews/:id {baseVersion, scheduledAt}`（后端自动重排提醒）。
- 统计：`GET /applications/stats?from=YYYY-MM-DD&to=YYYY-MM-DD` → `{interviewedCount, totalHours, efficiency}`；**`efficiency: null` 表示零工时，显示「暂无数据」**，不要显示 0。

## 5. 文件与二进制

- 上传：`FormData`，字段名必须 `file`；Content-Type 由浏览器设置。
- 下载/预览：`GET /documents/:id/content` 返回原始字节，带 `Content-Disposition: attachment`；如需内嵌预览 PDF，可用 `fetch` + `blob` + `URL.createObjectURL`（同样要带 Cookie）。

## 6. 离线同步协议（重点）

后端支持离线编辑的实体：`profile, experience, skill, evidence, job, portfolio, task, application, application_event, interview, time_entry`。

### 6.1 本地队列

- 离线写入先落 IndexedDB（含待提交操作队列），操作结构：

```json
{
  "opId": "客户端生成的唯一 ID（UUID，用于幂等）",
  "entity": "experience",
  "entityId": "客户端生成 UUID（新建）或服务器已知 ID（更新）",
  "baseVersion": 0,
  "action": "upsert | delete",
  "payload": { }
}
```

- **离线新建**：客户端自己生成 UUID，`baseVersion: 0`，服务器会以此 ID 创建。
- **离线更新**：`baseVersion` 必须等于离线时读到的服务器 `version`。
- **离线删除**：同样必须带当前 `baseVersion`；版本过期时返回 `conflict`，不能直接覆盖服务器的新修改。

### 6.2 提交与回执

`POST /sync/operations {operations: [...]}`（单次 ≤100 条）→ 逐条回执：

| status | 含义 | 前端动作 |
|---|---|---|
| `applied` | 已应用，附 `version` 与 `record` | 更新本地版本号 |
| `duplicate` | opId 重复提交（网络重试），附原回执 | 静默忽略（**不重复记工时/事件**的保障就在这） |
| `conflict` | 版本冲突或远端已删除，附 `record`（服务器当前/墓碑） | **弹冲突对比**：本地版本 vs 服务器版本，用户选择后：选本地 → 以服务器当前 version 为 baseVersion 重新提交；选服务器 → 丢弃本地 |
| `rejected` | 参数不合法，附 `details` | 提示修正后重新编辑 |

### 6.3 增量拉取

`GET /sync/changes?since=<cursor>&limit=100` →

```json
{ "cursor": 42, "hasMore": false, "changes": [{ "seq": 42, "entity": "experience", "entityId": "...", "version": 3, "changeType": "upsert|delete", "record": {}, "changedAt": "..." }] }
```

- 游标持久化在 IndexedDB；`changeType: delete` 是墓碑，本地同样删除。
- 多端同步：另一台设备对同一实体的修改会以 change 形式到达；若本地有未推送修改，走 6.2 冲突流程。

### 6.4 同步门禁（匹配/计划前置）

画像或经历有**未同步修改**时，必须先同步才能请求新的匹配/计划：

- 请求 `POST /matches` / `POST /plans` 时带上客户端当前已知版本（`clientProfileVersion`、`clientExperienceVersions`）；
- 若客户端版本**领先**服务端（有未推送修改）→ 409 `sync_required`：先同步，再重试。
- 工作台需展示：待同步条数、同步失败条数、冲突条数、最近同步成功时间。

### 6.5 与 PWA 缓存的边界（计划书要求）

- Service Worker 只缓存应用外壳（HTML/JS/CSS）；**不缓存简历原文件与全量 API 响应**。
- 离线可用数据 = IndexedDB 中已同步的实体 + 待提交队列。

## 7. 通知与推送

```
GET   /notifications                  站内提醒列表（已发送的），含 unreadCount
POST  /notifications/:id/read         标记已读
GET   /notifications/settings         {timezone, notifyTaskDue, notifyInterview}
PUT   /notifications/settings         修改提醒开关（任务到期 09:00 / 面试前 1h）
GET   /push-subscriptions/vapid-public-key    {publicKey}（空串 = 后端未配置推送）
POST  /push-subscriptions             {endpoint, keys:{p256dh, auth}}（按 endpoint 幂等 upsert）
DELETE /push-subscriptions/:id        取消订阅
```

推送 UI 约束（计划书）：**用户主动开启才请求浏览器通知权限**；拒绝或环境不支持时只保留站内提醒；提醒发送是尽力而为（Cron 每 15 分钟扫描），UI 不要承诺「准点推送」。

## 8. 联调自检清单

- [ ] 所有请求带 `credentials: "include"`；CORS 地址已报备后端
- [ ] 类型由 `openapi/openapi.json` 生成，不手写
- [ ] 登录页消费 `GET /session` 的 `demoUsers`；按 `role` 显隐管理员入口；`demoMode` 水印
- [ ] 五类 202 作业都有轮询 + 失败重试 + `resultRef` 取结果
- [ ] 所有更新走 `baseVersion`；409 冲突有「本地 vs 服务器」对比 UI
- [ ] 硬条件 `unknown` 不显示为通过；匹配分不表述为概率；组合预算不足有明确提示
- [ ] 离线：断网可编辑五类实体 → 恢复后批量提交 → `duplicate` 幂等 → 冲突可解决 → 增量拉取应用墓碑
- [ ] `sync_required` 场景：改完画像不刷新直接请求匹配 → 看到引导同步的提示
- [ ] 文件：上传 422（类型/大小/扫描件）都有文案与手动录入入口；文件内容仅本人可访问
- [ ] `efficiency: null` 显示「暂无数据」；投递非法流转被 422 拦截时文案可读
- [ ] 推送开关：未配置 VAPID（`publicKey` 为空）时隐藏；权限被拒后站内提醒仍可用

## 9. 常见问题

**Q: 404 到底是不存在还是没权限？** 后端统一 404，不区分。前端文案用「不存在或无权访问」。

**Q: 为什么列表接口没有 requirements？** 岗位列表为性能起见不组装要求，详情接口才返回。

**Q: 冲突后用户选了「保留服务器版本」，本地编辑就丢了吗？** 是。需要保留的话，把本地内容复制为新操作（新建或合并）再提交——重新提交仍会检查版本。

**Q: mock 模式下模型结果是假的吗？** 是（确定性假数据，引用必中原文）。`capabilities.demoMode` 时界面标明「模拟结果」；接入真实模型 API 只改后端配置，前端无感。

**Q: 时区？** 所有时间戳为 UTC ISO 字符串；用户时区存在 `profile`/`users.timezone`（默认 Asia/Shanghai），提醒由后端按用户时区换算，前端展示时本地化即可。
