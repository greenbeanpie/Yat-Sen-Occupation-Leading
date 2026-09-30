# 生产就绪审计：面向公众使用的缺口清单

- 审计日期：2026-09-30
- 审计基线提交：[`8de3897`](https://github.com/greenbeanpie/Yat-Sen-Occupation-Leading/commit/8de3897)（`main`）
- 方法：6 路并行独立审计（认证与密码学 / 数据保护与合规 / 可靠性运维 / 后端 API 质量 / 前端与体验 / 成本与扩展），由主审对关键结论逐条复核
- 适用对象：把本项目从「公开演示站」推进到「面向真实用户的生产服务」所需的整改清单

> 结论先行：**当前形态是「带真实注册能力的公开演示站」，不是生产服务。** 仓库对演示属性是诚实的（`DEMO_ENABLED=true`、`AI_PROVIDER=mock`、文档多处标注“待验证”），但一旦收真实用户与真实简历，下述 P0 项任一被触发即可导致全站失守、数据丢失或账单失控。

## 1. 评分概览

| 维度 | 当前水平 | 生产要求 |
|---|---|---|
| 认证与会话 | 有 PBKDF2 哈希、CORS 白名单、统一 401 防枚举（做得好）；但**无口令直登后门仍在** | 见 §2.1 |
| 越权防护 | 多数路由按 `user_id` 过滤；创建路径缺父实体归属校验 | 见 §2.2 |
| 滥用与成本 | **全路由零限流**、零配额 | 见 §2.3 |
| 合规与数据权 | 无政策、无同意、无注销、原文永久保留 | 见 §2.4 |
| 可靠性运维 | 零备份、零告警、无回滚流程 | 见 §3.1 |
| 测试门禁 | 本轮修复后本地可跑通（71/71） | 见 §5 |
| 前端体验 | 离线同步与游客隔离设计良好；403 挑战页误伤真实用户 | 见 §3.3 |

## 2. P0：不修不能接真实用户

### 2.1 身份与会话

| # | 问题 | 证据 | 验证 |
|---|---|---|---|
| P0-1 | **`POST /api/v1/session` 是无需口令的身份直登**：只需 `{userId}` 即可签发会话，且**不受 `DEMO_ENABLED` 约束**（该开关只控制演示身份播种与列表外显）。演示身份 UUID 是公开常量，攻击者可直登**演示管理员**并调用 `/admin/*`；真实账号一旦 UUID 泄露即可被完全冒充 | `backend/src/routes/session.ts` 的 `login` 处理（约 L116–126）：`getUser` → `issueSessionCookie`，无口令校验、无环境门禁 | ✔ 已复核 |
| P0-2 | **`SESSION_SECRET` 静默降级为公开硬编码值**，可离线伪造任意会话；缺失时无启动报错 | `backend/src/infra/db/helpers.ts:94` → `env.SESSION_SECRET \|\| "insecure-dev-secret"` | ✔ 已复核 |
| P0-3 | **无限流、无失败锁定、无验证码**：登录可无限爆破（每次 PBKDF2 烧 Workers CPU），注册机可批量灌 D1 | 全仓无 rate-limit / lockout / captcha 逻辑；`backend/docs/deployment.md` 自述“限流未实现” | ○ 审计报告 |
| P0-4 | **会话不可吊销**：登出只删客户端 Cookie，服务端无黑名单，令牌 7 天内仍有效；签名比较非恒定时间；payload 无 `iat/jti` | `backend/src/middleware/auth.ts` | ○ 审计报告 |
| P0-5 | **PBKDF2 参数偏低且无 pepper**：10 万次 SHA-256 低于当前 OWASP 建议；`verifyPassword` 信任存储串自带迭代数（1–10M），库被篡改可降级或造成 CPU DoS | `backend/src/infra/password.ts` | ○ 审计报告 |

**最小修复**：公网部署 `DEMO_ENABLED=false` 并在非演示环境**禁用/移除** `POST /session` 直登分支；未认证 `GET /session` 不再返回身份列表；`SESSION_SECRET` 缺失或过短即拒绝签发（不 fallback）；入口限流 + 失败锁定 + Turnstile；改为服务端会话表（可吊销、缩短 TTL、改密即失效）。

### 2.2 越权与数据完整性

| # | 问题 | 证据 | 验证 |
|---|---|---|---|
| P0-6 | **创建匹配时不校验岗位可见性**：可为他人私有岗位创建匹配快照 | `backend/src/routes/matching.ts:170` → `SELECT id, job_version FROM jobs WHERE id = ?1 AND deleted = 0`，无 `user_id` / 公共可见条件 | ✔ 已复核 |
| P0-7 | **创建子实体时不校验父实体归属**：`applicationId` / `taskId` / `jobId` 可直接填任意 UUID（包括他人私有岗位），写入行归属创建者，可污染统计与关联 | `backend/src/application/entity-writer.ts`（`createEntity` 只写 `user_id`，无 FK 归属校验）；`backend/src/routes/tracking.ts` `createApplication`（约 L240） | ✔ 已复核 |
| P0-8 | 生成计划时按 `jobId` 取岗位标题无 user 校验，他人岗位标题可能进入 AI 提示词 | `backend/src/application/generate-plan.ts` | ○ 审计报告 |
| P0-9 | `POST /documents/{id}/parse` 取文档时未带 `deleted=0`，已删文档可被复活解析 | `backend/src/routes/documents.ts` | ○ 审计报告 |
| P0-10 | `UPDATE jobs` 语句只用到 `?1` 却多绑定了一个未使用的 `userId`（靠显式占位序号侥幸正确），属高危维护隐患：后续有人改 SQL 会静默错位 | `backend/src/routes/jobs.ts:281–300` | ✔ 已复核 |

**最小修复**：所有按 id 取数统一为 `WHERE id = ? AND (user_id = ? OR <公共可见条件>)`；创建子实体前校验父实体归属；`parse` 补 `deleted=0`；清理 `jobs.ts` 多余绑定；补跨用户 404/403 集成测试。

### 2.3 滥用与成本敞口

| # | 问题 | 说明 |
|---|---|---|
| P0-11 | **全路由零限流**：匿名可直达注册、登录、上传、排队接口；免费档约 10 万请求/日量级，数小时可烧穿，付费档则是无上限账单 |
| P0-12 | **作业排队无并发/队列/去重**：`startOperation` 每次新建，`input_fingerprint` 已计算但未用于去重；刷 `POST /documents/{id}/parse`、`/matches`、`/plans`、`/rewrites` 可无限创建 Workflow 执行 |
| P0-13 | **列表多处全表扫描或静默截断**：`documents` / `portfolios` / `plans` / `admin/jobs` 无 `LIMIT`；`jobs` / `notifications` 硬 `LIMIT 100` 静默截断（客户端以为拿全） |
| P0-14 | **上传只信客户端 `file.type`**：无魔数嗅探、无每用户数量/容量配额、无病毒/宏扫描；10MB 校验发生在读入内存之后 |
| P0-15 | **`demo/reset` 可被任一登录者反复调用**（每次 26 条 DELETE），且只删 D1、**不删 R2 对象** → 既是写放大器也是存储泄漏 |
| P0-16 | **AI 切真实模型后无护栏**：无 `max_tokens`、无输入截断（整段原文直发）、无每用户预算、无熔断，单用户即可打出「超大 prompt × 重试 × 并发」三重账单 |

**最小修复**：边缘 + Worker 双层限流并分级（登录/注册/上传/AI 最严）→ 统一 429 + `Retry-After`；全局 JSON body 上限 413；列表统一游标分页；上传加魔数校验与配额，删除/RESET 联动删 R2；`startOperation` 用指纹做窗口去重并限制每用户并发；AI 上线前加输入截断、`max_tokens`、每用户日预算与超限 429。

### 2.4 合规与数据权（PIPL 视角）

| # | 问题 | 说明 |
|---|---|---|
| P0-17 | **删除只打墓碑，R2 原文永久保留**：`DELETE /documents` 自述“原始文件保留在私有桶中”，`demo/reset` 也不清 R2 → 无法履行删除权 |
| P0-18 | **无账号注销、无数据删除权、无数据导出**（PIPL 第 44–47 条） |
| P0-19 | **无隐私政策 / 用户协议 / 同意链路**：注册与上传前无告知（目的、方式、期限、权利、跨境、联系方式） |
| P0-20 | **日志 PII 未完全脱敏**：`filename` / `displayName` / `username` / `company` / `notes` / `feedback` 等未入脱敏名单；`unhandled_error` 直接打 `message + stack`（含 SQL、R2 key、用户输入），且 `observability.enabled=true` 长期保留 |
| P0-21 | **无保留期限**：`change_log`、`async_operations`、`parse_drafts`、`document_segments` 等只增不减，无 TTL 清理 |
| P0-22 | **学生/未成年人数据无特殊处理**：用户群体即学生，含未满 14 岁可能；无年龄门、无监护人同意、敏感字段无单独同意（PIPL 第 28/31 条） |
| P0-23 | **跨境未声明**：Workers 全球调度、D1/R2 region 未声明、切真实 AI 后简历与 JD 全文出境、推送网关多在境外，均无评估与单独同意 |

**最小修复**：删除/注销联动清 R2 与用户分区 → 上线《隐私政策》《用户协议》+ 注册/上传勾选 → 扩展脱敏名单并缩短日志保留 → 公布保留期限并由每日 cron 清理到期数据 → 补年龄声明与敏感字段单独同意 → 写明数据存放区域与跨境依据。

> ○ 上述证据来自审计报告，未逐条复核；整改前建议先复核对应实现。

## 3. P1：上线前应补

### 3.1 可靠性与运维

| # | 问题 | 说明 |
|---|---|---|
| P1-1 | **零备份**：D1 `yso-db` 与 R2 `yso-docs` 被文档标记为「永不重建」，却没有导出脚本、版本化、PITR 或恢复演练 |
| P1-2 | **迁移不可回滚且无门禁**：只有前进迁移；文档自述“必须先迁移 0002 再部署，否则 500”，但没有「远端未 apply 即禁止发布」的硬门 |
| P1-3 | **无版本化回滚流程**：靠人工记忆记录 Worker 版本；该仓库**已发生过误删前端 Worker 对象**（新 ID、版本历史丢失） |
| P1-4 | **无健康检查与告警**：无 `/healthz`（不探 D1/R2/Workflow 绑定），无 5xx 率/延迟告警，无通知渠道与 on-call |
| P1-5 | **cron/Workflow 失败不可见，且重试实际失效**：`cronTick` 先把提醒置 `sent` 再推 push，失败只累加 `retry_count`，而下一轮只取 `status='pending'` → **永远不会重推**；每轮 `LIMIT 50`，积压无告警；`startOperation` 在落库后、dispatch 前崩溃会永久停在 `queued`，无 sweeper | ✔ 状态顺序已复核 |
| P1-6 | **密钥轮换无流程**：`SESSION_SECRET` 轮换会直接踢掉全站会话，无双密钥过渡；VAPID/AI key 无泄漏应急预案 |

### 3.2 API 契约与质量

- 仅 `/sync/*` 有幂等（`opId`）；其余 POST 无 `Idempotency-Key`，`confirmDraft` 条件更新非原子 + 无唯一约束 → **双击可重复写入**
- 错误码只有 400/401/403/404/409/422/500，**缺 429 / 413 / 408 / 503**；无 `Retry-After`、无 Request-Id 透传
- OpenAPI `info.version` 硬编码 `1.0.0`，无破坏性变更流程、无双版本共存、无 Sunset/Deprecation 头
- 缺陷回归面：审计建议补契约语义 diff、故障注入（AI 429/5xx、R2 丢失、D1 繁忙）、竞态与限流测试

### 3.3 前端与体验

| # | 问题 | 说明 |
|---|---|---|
| P1-7 | **Cloudflare 403 挑战页误伤真实用户（公网最大隐性风险）**：已实证拦截自动化与无头浏览器；真实用户在 Bot Fight Mode / 高 Security Level 下会白屏或全接口报「请求失败 (403)」，而前端**无挑战识别、无专用文案、无状态页** |
| P1-8 | 登录页四入口（账号 / 演示身份含管理员 / 游客 / 临时演示模式）在 http 生产构建下**全部默认开启**，且无环境开关可单独关闭演示入口 |
| P1-9 | **离线仅对 TypeError/NetworkError 入队**：HTTP 5xx / 429 / 超时直接抛错，本地编辑只在表单 state，刷新即丢；无 `beforeunload` 挽留 |
| P1-10 | PWA 为 `prompt` 模式，用户忽略则旧壳长期驻留；界面无版本指纹，更新失败仅 `console.warn` |
| P1-11 | `job.sourceUrl` 仅浏览器 `type=url` 校验，直接进 `<a href>` → `javascript:` 等伪协议可点击执行（需 http(s) 白名单） |
| P1-12 | 缺 `autocomplete="username/current-password/new-password"`；Modal 无焦点陷阱/Esc；表单错误未关联 `aria-describedby`；底部导航字号/触区偏小 |

## 4. 演示可接受 / 公网不可接受

| 项 | 演示站为何可接受 | 公网为何不可接受 |
|---|---|---|
| `POST /session` 无口令直登 + 未认证返回身份列表 | 一键体验是演示的核心功能 | 任何人可登入演示管理员；真实账号 UUID 泄露即被冒充 |
| `DEMO_ENABLED=true` + `/demo/reset` 删当前身份数据 | 演示要能一键重置 | 被刷即 D1 写放大；R2 原文不删造成泄漏 |
| `SESSION_SECRET` fallback 公开值 | 本地开发免配置 | 全站会话可伪造 |
| 无限流 / 无锁定 / 无验证码 | 演示流量小 | 凭据填充、注册机、写入费用攻击 |
| 登出仅删 Cookie、7 天不可吊销 | 演示无真实损失 | 盗 Cookie = 7 天完全接管，改密也踢不掉 |
| 墓碑删除、R2 原文保留 | 演示无删除权诉求 | 违反 PIPL 删除权与最小必要 |
| 无隐私政策 / 无同意 / 无注销 | 演示不收集真实数据 | 合规硬性缺失 |
| AI 为 mock 假数据 | 演示可解释 | 真实用户会误信建议质量 |
| 无备份 / 无告警 / 无回滚演练 | 演示数据可重建 | 一次误操作即永久丢数据 |

## 5. 上线最短路径

**阶段一（阻断项，必须全清）**

1. 关演示：`DEMO_ENABLED=false`；非演示环境禁用 `POST /session` 直登；`GET /session` 不再外显身份列表
2. 强制密钥：`SESSION_SECRET` 缺失/过短即拒绝签发；写入 32B+ 随机值
3. 入口限流 + 失败锁定 + Turnstile；`demo/reset` 与注册加频次限制
4. 修 §2.2 越权（P0-6/7/9/10）与 R2 联动删除
5. 上线隐私政策 / 用户协议 / 同意勾选；补账号注销与数据导出

**阶段二（可靠性）**

6. D1 每日导出至 R2 归档桶 + 季度恢复演练；R2 开版本化
7. 迁移门禁：`deploy-preflight --strict` 作为发布硬门，远端未 apply 即失败
8. 从本次部署起记录「提交 → 前后端版本 ID → 迁移版本」，写回滚 runbook（代码可回滚，D1/R2 永不随代码回滚）
9. 加 `GET /api/v1/healthz`（探 D1 `select 1`、R2、Workflow 绑定）+ 合成监控 + 5xx 告警
10. 修 `cronTick` 状态顺序（push 成功后才置 `sent`），加积压指标与 `queued` 超时 sweeper

**阶段三（质量与体验）**

11. 全列表分页 + 幂等键 + 429/413/503 错误码；契约版本化
12. 前端识别 403 挑战页并给专用重试文案；运维侧为 `/api/v1` 与静态资源配置跳过/低摩擦规则
13. 生产构建默认隐藏演示入口；补 CSP/HSTS；`sourceUrl` 协议白名单；离线队列覆盖 5xx/超时；PWA 版本指纹与失败提示；a11y 修补

## 6. 本轮已完成的加固（2026-09-30）

- **依赖漏洞清零**：`vitest` 3.2.7 → 4.1.11、`@cloudflare/vitest-pool-workers` 0.9.14 → 0.18.7（保持稳定版 Miniflare 4）、`wrangler` 4.44.0 → 4.144.0、`@cloudflare/workers-types` 4 → 5，并 override `undici ^7.29.1`、`sharp ^0.35.4`。前后端 `npm audit` 均为 0 条。
- **测试门禁恢复可信**（改善 §3.1 发布门禁能力）：原先后端集成测试 71 条中 53 条失败（workerd `std::terminate`），根因是沙箱化 Windows 会话下子进程对 `%TEMP%` 只读，workerd 无法创建持久化目录。将 Miniflare 临时根目录重定向到已 gitignore 的 `backend/test/.tmp` 后，`npm test` **71/71 通过**，`node scripts/deploy-preflight.mjs` **15/15 通过**（此前 14/1）。
- 相关改动为 devDependency 与测试夹具，未触及 Worker 运行时源码。

## 7. 审计方法与证据说明

- 6 路审计各自独立阅读源码与配置，输出「现状小结 / 必修项 / 最小修复 / 演示与公网区分」；主审汇总去重后对下列结论做了逐行复核并标注 ✔：`POST /session` 直登、`SESSION_SECRET` 降级、`cronTick` 状态顺序、`matching` 创建缺可见性、`entity-writer` 缺父实体校验、`jobs` 更新多余绑定。
- 标注 ○ 的结论来自审计报告文本，包含文件路径但未逐行复核；**整改前请先复核对应实现**。
- 未做的工作：未做渗透测试、未做真实模型接入验证、未做负载/压测、未做 Cloudflare 生产环境浏览器端复验（生产域名存在 403 安全挑战，见 §3.3 P1-7）。

---

相关文档：[计划对照](plan-gap-analysis.md)、[后端部署文档](../backend/docs/deployment.md)、[前后端集成](../backend/docs/frontend-integration.md)。
