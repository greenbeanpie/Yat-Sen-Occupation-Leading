# 邀请注册与管理员发布接续

本轮保留第一阶段全部未提交修改；HEAD 仍为 `c9f522ab1b33076cb7f6dfcc1904d0524f2b7920`。未提交、推送、创建 PR、迁移或部署。后续发布同时包含第一阶段安全修复。未修改 AI-Colleboration-Seminar。

## 行为与安全复核

- 新用户名限 3–32 个 ASCII 字母、数字、下划线、连字符，存储为小写；登录去除首尾空格并忽略大小写。数据库 `lower(trim(username))` 唯一索引覆盖软删除账户，防止名称被重新领取。旧账户名称、ID、密码摘要、角色与业务数据不变；历史大小写/空格碰撞使迁移失败，不自动合并。
- 邮箱选填，`email_verified_at=NULL`。不发送验证码；邀请码不绑定邮箱；无邮箱找回、短信找回、万能密码或恢复登录端点。
- 按用户追加要求：邀请码为 **16 个大小写敏感 Base64URL 字符，96 位随机熵**；只存域分隔 SHA-256 摘要。每次注册必须消费一个未撤销、未到期的邀请码，D1 batch 事务在插入时复查资格，插入账户与消费原子完成。并发同邀请码仅一人成功，用户名冲突不消耗邀请码。
- 仅 `is_demo=0` 的真实管理员可以创建、查看状态、撤销邀请码。默认有效 24 小时，可设置 1–168 小时，状态列表最近 100 条。无专用管理员创建频率限制；保留原通用 IP 180/min、用户 120/min 防滥用限制。明文仅创建时返回，在管理员页面临时显示，不进入离线缓存。
- 注册/登录/演示登录共享原 IP 20/min；凭据登录另有规范化用户名 10/min。未知账户执行同成本 PBKDF2 并返回同一 401 文案。新密码沿用盐化 PBKDF2-SHA256 600000 轮，旧 100000 轮成功登录后升级。密码 8–128 字符。
- 沿用 24 小时服务端持久会话与 Secure/HttpOnly/SameSite=Lax Cookie；注销撤销当前会话。认证和邀请码管理响应 `no-store`。日志新增邮箱、邀请码与邀请码摘要脱敏。
- 公开演示身份保留；演示管理员不是真实管理员，无法管理邀请码、真实用户、真实管理数据。已有第一阶段越权回归继续通过。

逐项复核了数据库事务并发、大小写冲突、删除账户名称保留、管理员与演示边界、过期/撤销、明文保存、未验证邮箱和旧凭据兼容性。没有另起代理并发修改。回归使用真实本地 workerd/D1；浏览器回归使用明确标注的 API mock，不能当作生产端到端验证。

## greenbp 初始化资料

用户明确要求预设 `greenbp` 真实管理员、随机密码、邮箱 `zgpride87@outlook.com`；本轮仅准备资料，不执行生产写入。

- `backend/scripts/prepare-admin.mjs` 默认只输出计划，`--prepare` 在本机生成一次性的管理员 INSERT SQL 和 32 字符随机密码（192 位随机熵）。已准备完成，不需要重新生成。
- SQL：`backend/.wrangler/admin-bootstrap/greenbp.sql`。
- 密码：`backend/.wrangler/admin-bootstrap/greenbp.password.dpapi`，内容为当前 Windows 用户 DPAPI 加密的字节串。目录移除继承 ACL，仅当前 Windows 用户拥有权限；`.wrangler/` 已被 Git 忽略。
- SQL 不覆盖任何已有用户；重复执行因 ID/规范化用户名唯一约束失败。邮箱仍未验证，不授予恢复权限。只在 0003、0004 已应用后执行，不能加入可自动重放的公共迁移。
- 密码不在聊天、日志或命令参数中出现；不能在其他 Windows 用户/电脑上解密。请在发布后由本人在本机终端解密并保管，不把输出发给助手：

```powershell
[Reflection.Assembly]::LoadWithPartialName('System.Security') | Out-Null
$encrypted = [IO.File]::ReadAllText((Join-Path (Get-Location) 'backend/.wrangler/admin-bootstrap/greenbp.password.dpapi')).Trim()
$bytes = [Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($encrypted), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Text.Encoding]::UTF8.GetString($bytes)
```

不要让助手运行上述显示密码命令。密码资料不要提交、同步至公共云盘或加入部署资产；SQL 与密码受本机用户权限和备份策略保护。

## 人工恢复设计

忘记密码时联系邀请人/站点负责人。未验证邮箱、持有旧邀请码、知道用户名均不能证明身份。负责人根据注册时的受邀关系，通过独立的已知联系渠道核验并记录恢复授权；证据不足时拒绝恢复，不自动绑定或信任表单邮箱。

经单次明确授权后，由有 D1 运维权限的人员离线生成新盐化密码摘要，事务内按**确切用户 ID 与原摘要条件**更新，并删除该用户所有 `sessions`。不得修改角色、改用户 ID、转移数据或使用通用恢复口令。新密码通过经核验的独立渠道交付；操作者不得把密码、摘要或 token 输出到助手聊天。本轮未实现/执行恢复写入工具，也未创建网页恢复端点；这是低频运维恢复流程。

## 真实可用发布路径与阻塞

只读核对：现有 Wrangler 已登录，账户 `17a6817bca6612a9cb11d0395eeba0ac`；D1 `yso-db` ID `a3a5c86a-d7f7-46f7-b1d1-9440f6ec9322`、私有 R2 `yso-docs` 存在。`SESSION_SECRET`、`VAPID_PRIVATE_KEY`、`VAPID_SUBJECT` secret **名称**存在，未读取或更改值。SESSION_SECRET 名称不能证明随机强度/长度，持有者必须确认至少 32 UTF-8 字节且高熵；若不足，另行授权替换。没有创建新 Cloudflare 凭据。

远端聚合查询：真实未删除账户 **0**（因此真实管理员 **0**），规范化用户名冲突组 **0**。查询 `changes=0/rows_written=0`。线上后端当前版本为 `e786861a-fd52-4c7d-a554-33efe4c470a0`，与早期文档不同，以发布时再读的活动版本为准。

发布前仍需核对两 Worker 的实际 ID、custom domain、入站 Service Binding 和 bindings；现有路径为后端 `greenbp-intern-workbench-backend`，前端 `greenbp-intern-workbench`（`workers_dev=false`），`BACKEND` 绑定精确指向后端，生产网站 `https://intern.greenbp.dpdns.org`。不重建 Worker、D1、R2，不运行资源 bootstrap。保留 `DEMO_ENABLED=true`、`AI_PROVIDER=mock`；身份认证转为真实凭据，但 AI 仍是 mock。

经父线程协调后按顺序执行：

1. 重新核对 Git 修改并提交完整经验证工作；本轮没有提交/推送权限。最终合入 main 后依仓库规则推送 origin，但须由后续授权线程执行。
2. 记录活动 Worker 版本与 D1 Time Travel 恢复点；检查生产已有绑定与状态，复查用户名冲突计数。
3. 在 `backend/` 运行 `npm run db:migrate:remote`，只应用待定 **0003_security_controls.sql + 0004_invitation_registration.sql**。不 reset、不重建表/数据库、不删除真实业务数据。
4. 执行完整 `node scripts/deploy-preflight.mjs --strict`，缺迁移或读取失败必须停止；不要用 quick 代替完整本地检查。
5. 在 `backend/` 运行 `npm run deploy`，先发布后端。父线程需在执行时针对账户、现有 DB 和 `greenbp` 管理员持久权限取得明确行动确认，并安排安全用户接管，由用户在本机安全流程中向确切现有 DB 提交准备好的 SQL。经确认的命令为 `npx wrangler d1 execute DB --remote --file .wrangler/admin-bootstrap/greenbp.sql`。这是一笔真实管理员权限写入，不得由助手在生成后自动远端提交、要求用户在聊天粘贴密码或绕过接管；必须记录执行结果，不得自动重试覆盖账户。
6. 在 `frontend/` 运行 `npm run deploy`，原位发布现有前端 Worker。没有新生产邀请码提前生成；首次由 greenbp 登录后在管理员页面创建。
7. `node backend/scripts/smoke-deploy.mjs https://greenbp-intern-workbench-backend.hddhp.workers.dev`，另验证生产域名同源 `/api/v1/session`、greenbp 登录、创建/撤销邀请码、一次性注册、选填邮箱、持久会话/注销和演示访问隔离。真实注册测试会写生产数据，需选定经授权测试账户；没有邀请码或没有授权就不声称已验证。

自动客户端曾遇 Cloudflare 403 安全挑战；若再次发生，使用正常浏览器验证并记录，不能把挑战当成认证通过。`smoke-deploy.mjs` 已增加“无邀请码被拒绝”和邀请契约检查，不自行创建邀请码/注册账户。

## 影响与回滚

0003 使旧 Cookie 失效，用户重新登录；0004 增加规范化唯一索引、邮箱列与邀请码表，不改账户 ID/数据。新版前端要求邀请码；旧前端无邀请码注册请求返回 422，登录仍兼容。迁移先行、后端先于前端。

不删除新增表/列来回滚，不把旧不安全 Worker 版本直接当作安全回滚：旧版本可能重新开放注册、恢复演示越权或无效会话行为。紧急止新注册可经授权撤销所有未使用邀请码；现有用户和会话不受影响。优先向前修复，必要代码回滚必须保留 0003 安全边界、0004 邀请注册门禁和完整结构兼容。若确需数据库恢复，先评估恢复点之后的新用户、会话和业务写入损失，独立批准；禁止例行 reset。

## 验证结果

- 原目录完整 `node scripts/deploy-preflight.mjs`：**15 通过 / 0 失败 / 0 待办**。涵盖后端 typecheck、104/104 Vitest（17 文件）；前端 typecheck/lint、39/39 Vitest（6 文件）、build；OpenAPI 与生成类型一致；两 Worker deploy dry-run；Cloudflare 登录/D1/R2 只读检查。
- `--quick --strict`：**7 通过 / 1 失败 / 1 提示**，远端缺 0003、0004；线上发布尚未就绪。quick 提示是跳过已经完成的本地质量检查。
- 浏览器 `frontend/e2e/invitation-registration.mjs --serve`：通过；使用已安装 Chrome、临时本机 Vite，API mock。验证 16 字符必填码、邮箱可不填、422 错误反馈、输入保留、恢复说明、密码/邀请码不写 Web Storage。截图在 `frontend/e2e/.artifacts/invitation-register.png`，截图前清空密码/邀请码。
- 首次本地测试/构建因沙箱 `spawn EPERM` 失败；自动审批允许真实本地子进程后完成。首次全预检因新增迁移测试漏应用 0002 导致夹具失败，修正后全通过。首次浏览器清理截图的精确 label 因错误文本附加而超时，改为稳定 input locator 后通过。未将失败算作通过。
- `git diff --check`、发布/初始化脚本语法检查通过。greenbp 加密密码在内存解密后与生成的 600000 轮摘要匹配；初始化 SQL 在全迁移的隔离内存 SQLite 中执行成功，重复执行拒绝覆盖；输出只有验证结果。未执行生产冒烟或生产新功能验证。

## 本轮文件清单（不含第一阶段其他改动）

新增：`backend/migrations/0004_invitation_registration.sql`、`backend/src/infra/invitations.ts`、`backend/src/routes/invitations.ts`、`backend/test/invitation-registration.test.ts`、`backend/scripts/prepare-admin.mjs`、`frontend/src/pages/InvitationsPanel.tsx`、`frontend/e2e/invitation-registration.mjs`、本文档。

修改：`backend/src/app.ts`、`backend/src/infra/db/schema.ts`、`backend/src/infra/logger.ts`、`backend/src/routes/session.ts`、`backend/src/shared/schemas/session.ts`、`backend/test/helpers.ts`、`backend/test/session-credentials.test.ts`、`backend/test/security-regressions.test.ts`、`backend/test/migration-parity.test.ts`、`backend/scripts/smoke-deploy.mjs`、`backend/openapi/openapi.json`、`frontend/src/api/schema.ts`、`frontend/src/api/client.ts`、`frontend/src/api/client.test.ts`、`frontend/src/ui.tsx`、`frontend/src/pages/AdminPage.tsx`、`docs/security-fix-runbook.md`。
