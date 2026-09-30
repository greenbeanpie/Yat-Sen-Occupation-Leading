# 项目1：邀请认证生产发布记录

网站：<https://intern.greenbp.dpdns.org>。本次两阶段代码提交为 `b9c55e98c8202c0e73fa3d178243fa6a5ebba96e`，已在既有 `origin/main` 核验，未强推、未创建 PR。本轮不包含深色模式；该需求留给另一个对话。

## 实际发布结果

| 对象 | 保留的既有目标 | 活动版本 / 状态 |
|---|---|---|
| 后端 Worker | `greenbp-intern-workbench-backend` | `b78ba60f-1ab8-4845-b7d5-a4cdfbad5dd7`，100% 活动 |
| 前端 Worker | `greenbp-intern-workbench` | `f7096a3b-4525-4c48-9046-d06b54f43e9c`，100% 活动 |
| 前端域名 | `intern.greenbp.dpdns.org` | 既有 custom domain，`workers_dev=false` |
| 同源 API | 前端 `BACKEND` Service Binding | 保留指向 `greenbp-intern-workbench-backend` |
| D1 | `yso-db` / `a3a5c86a-d7f7-46f7-b1d1-9440f6ec9322` | 0001–0004 均已应用，无待应用迁移 |
| R2 | 私有 `yso-docs` | 既有绑定保留，无重建/删除 |

Cloudflare 账户：`17a6817bca6612a9cb11d0395eeba0ac`。后端直接地址：<https://greenbp-intern-workbench-backend.hddhp.workers.dev>。没有新建 Worker、数据库、存储桶或凭据，没有旋转 secret，没有创建真实管理员或签发真实邀请码。`DEMO_ENABLED=true`、`AI_PROVIDER=mock` 保留。

接续时核对发现代码提交/推送、迁移和后端发布已由现有发布流程完成，因此核验后接续前端原位部署，没有重复迁移或重复发布后端。前端上传和部署成功，活动版本与版本绑定已另行读取确认。仅前端代码实际上传至既有 Worker；本记录不影响部署资产。

## 迁移与恢复依据

0003 增加持久会话、限流、确认 token、通知投递记录和索引，并把历史已发送通知标记为完成，避免重放；0004 增加规范化用户名唯一索引、选填邮箱列和邀请码表。两者不删除用户、账户 ID 或业务数据。规范化用户名冲突查询结果为 0；迁移状态独立核对显示 0003、0004 已应用。

发布前时间点 `2026-09-30T15:55:00Z` 对应 D1 Time Travel 恢复书签：

`00000059-00000002-000050f6-b77de3275388f15db0c91681fb94725e`

这是恢复依据，不是已经执行的恢复或独立导出备份。不得例行恢复、删除新表或退回存在安全缺陷的旧后端；恢复会丢失该时间点之后的会话和业务写入，必须另行评估授权。旧后端版本 `e786861a-fd52-4c7d-a554-33efe4c470a0`、旧前端版本 `d07fd372-b29c-49da-a6b1-55b8e9a24fc3` 仅用于追溯，不作为未经评估的安全回滚建议。

## 验证

- 完整 `node scripts/deploy-preflight.mjs --strict`：**16/16 通过**，包含本地后端 104 项、前端 39 项回归、类型/lint/build、契约一致性、两 Worker dry-run、账户/D1/R2 和全部远端迁移检查。
- 代码提交 CI 已到终态 **success**：[运行 36740545246](https://github.com/greenbeanpie/Yat-Sen-Occupation-Leading/actions/runs/36740545246)。本记录的独立提交 CI 在最终交接中另行汇报，不把排队状态当成成功。
- 后端生产标准冒烟 **14/14 通过**：演示会话签发与读取、profile、注销、注册/登录契约、无邀请码拒绝注册、未知账户拒绝登录。
- 追加后端权限冒烟通过：`healthz=200`、匿名邀请码管理 401、演示管理员查看/创建邀请码 403、演示管理员访问真实管理接口 403、注销后重放 Cookie 被拒绝、无邀请码注册 422。Cookie 仅在内存使用，没有输出。
- `SESSION_SECRET` 原值沿用。新版运行时签验成功，证明满足至少 32 UTF-8 字节长度要求并能用于会话签验；**不证明随机强度**，持有者仍需核验原生成方式。未读取值或生成替代密钥。
- 自定义生产域名的首页与同源 `healthz` 自动 HTTP 请求均返回 **Cloudflare 403 challenge**；新 Chrome 上下文也返回挑战页“请稍候…”。因此**未完成该域名的完整端到端认证验证**。没有为自动测试修改安全规则、绕过挑战、创建替代 Worker 或开放 workers.dev。
- 新注册表单此前本地真实浏览器 UI 回归通过，使用明确标注的 API mock；不能将其视为生产域名验证。
- 一次补充生产脚本最初使用错误的固定演示 ID，被正常拒绝 404；改为读取服务端公开演示列表中的管理员 ID 后权限回归通过。这不是生产认证故障。
- 真实账户与邀请码计数核对均为 **0**。管理员初始化材料、加密密码、摘要 SQL、`.dev.vars`、`.wrangler/`、测试缓存和截图未进入 Git。临时权限冒烟脚本只在忽略目录运行。

## 用户需要完成的最小操作

1. **在本人正常浏览器打开生产网站并完成 Cloudflare 的安全挑战**，确认能看见新版登录/注册页面。若正常用户仍被持续拦截，需审查对应安全事件；未经确认不更改安全规则。
2. **安全接管管理员初始化**。在本机 `backend/` 目录先用 `npx wrangler whoami` 确认上述账户，核对 `wrangler.jsonc` 指向既有 `yso-db`，再自行执行：

   ```powershell
   npx wrangler d1 execute DB --config wrangler.jsonc --remote --file .wrangler/admin-bootstrap/greenbp.sql
   ```

   这是创建 `greenbp` 真实管理员的持久权限写入，助手尚未执行。文件只含盐化密码摘要；重复执行拒绝覆盖。不要重新运行准备工具，也不要把 SQL、摘要或密码发到聊天。
3. **本人本机解密随机密码并登录**。按 [邀请认证接续文档](invitation-auth-runbook.md#greenbp-初始化资料) 的本机操作读取 DPAPI 加密密码，仅由本人输入网站登录框；不交给助手、不放入代码/日志/报告。邮箱 `zgpride87@outlook.com` 仍未验证，不能找回密码。
4. 登录管理员页面后创建首个一次性邀请码，按受邀关系发放。亲自验证选填邮箱注册、邀请码只能使用一次、登录/刷新/注销和演示隔离。此次助手没有创建真实邀请码或真实测试账户，这部分生产功能仍待本人验证。
5. 核验现有 SESSION_SECRET 来自安全随机生成并妥善保存；仅名称存在和长度通过不足以证明强度。若需更换，另行明确授权通过 Wrangler secret 安全录入，勿在聊天提供值。

旧版 Cookie 因升级为服务器可撤销会话而失效，需要重新登录。真实用户人工恢复仍走独立身份核验和单次运维授权，不使用未验证邮箱或公开认证后门。
