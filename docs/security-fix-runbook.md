# 本地安全修复验证与发布前事项

本轮只修改本地 Yat-Sen-Occupation-Leading；不触及 AI-Colleboration-Seminar，不推送、不部署、不修改线上 D1/R2/秘密。39项复核详见 [production-readiness-review.md](production-readiness-review.md)。

## 数据与兼容性

- 新增 `backend/migrations/0003_security_controls.sql`，增加可撤销会话、窗口计数器、草稿确认token、推送送达记录与查询索引；历史已发送且retry=0的提醒设为完成，避免回放。无删除现有账号/用户数据的迁移。
- **生产部署前必须先审阅并应用迁移0003**，本轮未执行。新版代码缺表时不能运行；旧代码可在新增字段/表的数据库上运行，但旧认证缺陷会恢复，不能把回滚视为安全修复。
- `SESSION_SECRET` 必须至少32字节，保持现有有效强secret，不公开值。会话改为服务端记录，旧版Cookie不再有效，用户需重新登录；新会话24小时，登出只撤销当前会话。
- 旧10万PBKDF2 hash在成功登录后升级到60万，保留账号id和所有关联数据。不改变实际管理员权限。演示身份不能访问管理接口或管理公共岗位，避免公共资源未分区的风险。
- 限额：认证IP20/min、通用IP180/min、用户120/min，作业并发3/24h50，文档20/100MiB，reset2/hour；边缘防护、套餐预算、异常告警需运营复核。D1计数窗口不等于阻断网络层DDoS。
- JSON及multipart请求均有11MiB入口上限；上传本体上限10MiB。列表支持limit1–100、cursor有界offset与nextCursor；前端自动取后续页。并发修改时不是快照一致分页。
- D1/R2不存在跨服务事务：删除先墓碑阻断读取，再清对象；上传结束复查处理删除/reset竞态。R2删除失败可重复DELETE重试；进程中断遗留对象的定期核查、全账号注销、备份生命周期仍未实现。

## 验证

后端 `npm run typecheck`、`npm test -- --no-file-parallelism`；前端 `npm run typecheck`、`npm run lint`、`npm test`、`npm run build`。导出 `backend npm run export:openapi` 后运行 `frontend npm run generate:api`。仓库根运行 `node scripts/deploy-preflight.mjs` 校验契约及两个Worker dry-run；`--strict`还只读核验全部远端迁移，缺迁移/读失败必须阻断正式发布。

隔离副本在此Windows环境中workerd/esbuild子进程对部分新目录写入受限：测试使用 `YSO_TEST_TMP_DIR` 指向原checkout已忽略的 `backend/test/.tmp/tmp-root` 后真实workerd测试可执行；不将初始化失败计为测试通过。测试helper默认仍使用当前项目内的已忽略目录，esbuild用write:false由Node写本地bundle。

### 最终结果

修复已通过正常审批应用原checkout：`C:\Users\hmz\Documents\SYSU-data\Yat-Sen-Occupation-Leading`。应用前再次检查HEAD及git状态，原目录无用户并发修改。当前分支`main`，HEAD仍为`c9f522ab1b33076cb7f6dfcc1904d0524f2b7920`，本轮修改保持未提交状态。隔离副本`C:\Users\hmz\Documents\Codex\2026-09-30\task\yso-review`保留；初始完整补丁`yso-stage1.patch`后另补严格预检Windows引用和本文最终结果，以原checkout为最终版本。

| 检查 | 原checkout结果 |
|---|---|
| 后端typecheck | 通过 |
| 后端全量Vitest | **95/95通过，16测试文件**；真实workerd/D1/R2正常初始化 |
| 前端typecheck / lint | 通过 |
| 前端Vitest | **38/38通过，6测试文件** |
| 前端生产构建 | 通过 |
| OpenAPI与前端生成类型一致性 | 通过；导出现在直接读取路由注册表，不执行运行时限流 |
| 后端与前端wrangler deploy --dry-run | 均通过，未部署 |
| 根目录完整deploy-preflight | **15通过 / 0失败 / 0待办** |
| --quick --strict预检 | **7通过 / 1失败 / 1提示**：线上缺`0003_security_controls.sql`，门禁按预期阻止发布；quick只跳过已完成的本地全量检查 |
| git diff --check / 39项记录数 | 通过 / 39 |

失败历史：隔离环境初始spawn EPERM/workerd初始化及两个dry-run写入拒绝，均未记为通过；测试临时目录和Node写bundle解决测试权限，两个dry-run在原目录成功。开发中发现OpenAPI导出执行限流无DB导致500，已修；新增竞态测试的Node流缺固定长度已在测试适配器修正；演示管理员隔离后旧夹具预期失败，改为本地真实管理员夹具并全量通过。没有自动审批拒绝，所有原目录写入均获批准。

**发布阻塞**：远端尚未应用0003，不能直接发布新版；本轮不执行线上迁移、secret配置或部署。没有运行真实AI、生产浏览器复验、负载测试、外部告警演练、真实Workflow重试耗尽故障注入或生产恢复演练。后端无单独lint/build脚本：使用typecheck和Worker dry-run验证相关源码与打包。

## 后续邀请登录阶段

最新需求为**用户名＋密码注册/登录，邮箱可选，不发送验证码，邀请码原子单次消费且不绑定邮箱**。未填/未验证邮箱不能找回密码。需要保持现有账号id/hash/关联数据，规范化用户名时先检查历史大小写碰撞，不能静默合并账号。

发布路径保持既有 Workers：后端`greenbp-intern-workbench-backend`、前端`greenbp-intern-workbench`、域名`https://intern.greenbp.dpdns.org`，原D1`yso-db`与私有R2`yso-docs`不重建。后续应审阅邀请表/用户名迁移，核验强SESSION secret与Service Binding，确认演示与真实用户的边界，再先后端后前端发布。实际邀请码签发、真实管理员赋权、秘密配置及生产变更均需明确授权；本地夹具不属于生产邀请。

本轮结束在第一阶段，不自动开始第二阶段；由父线程在用户要求的Fast模式接续。需要保留最新用户名需求、现有账号兼容及大小写碰撞处理、公开演示管理员禁止真实管理权限、未验证邮箱不能找回密码、无生产授权/邀请码或secret签发，以及远端0003未应用的状态。

## 本轮变更文件（55个）

- backend/migrations/0003_security_controls.sql
- backend/openapi/openapi.json
- backend/scripts/export-openapi.ts
- backend/src/app.ts
- backend/src/application/access.ts
- backend/src/application/entity-writer.ts
- backend/src/application/generate-match.ts
- backend/src/application/generate-plan.ts
- backend/src/application/operations.ts
- backend/src/application/parse-document.ts
- backend/src/application/parse-job-requirements.ts
- backend/src/application/reminders.ts
- backend/src/infra/ai/index.ts
- backend/src/infra/db/helpers.ts
- backend/src/infra/db/schema.ts
- backend/src/infra/extract/docx.ts
- backend/src/infra/logger.ts
- backend/src/infra/pagination.ts
- backend/src/infra/password.ts
- backend/src/infra/rate-limit.ts
- backend/src/infra/workflows/index.ts
- backend/src/middleware/auth.ts
- backend/src/routes/admin.ts
- backend/src/routes/demo.ts
- backend/src/routes/documents.ts
- backend/src/routes/health.ts
- backend/src/routes/jobs.ts
- backend/src/routes/matching.ts
- backend/src/routes/notifications.ts
- backend/src/routes/planning.ts
- backend/src/routes/session.ts
- backend/src/routes/tracking.ts
- backend/src/shared/schemas/jobs.ts
- backend/src/shared/schemas/notifications.ts
- backend/test/demo-reset.test.ts
- backend/test/helpers.ts
- backend/test/jobs-matching.test.ts
- backend/test/migration-parity.test.ts
- backend/test/plans-tracking.test.ts
- backend/test/security-regressions.test.ts
- backend/test/sync.test.ts
- docs/production-readiness-audit.md
- docs/production-readiness-review.md
- docs/security-fix-runbook.md
- frontend/src/api/client.test.ts
- frontend/src/api/client.ts
- frontend/src/api/schema.ts
- frontend/src/components.tsx
- frontend/src/pages/JobsPage.tsx
- frontend/src/safe-url.test.ts
- frontend/src/safe-url.ts
- frontend/src/ui.tsx
- frontend/src/worker.ts
- frontend/vite.config.ts
- scripts/deploy-preflight.mjs

## 第二阶段本地实现接续

邀请注册、16 字符邀请码、选填未验证邮箱、greenbp 管理员安全初始化资料与最新发布步骤见 [invitation-auth-runbook.md](invitation-auth-runbook.md)。第一阶段本地修改仍全部保留，生产迁移和部署仍未执行；第二阶段文档中的只读线上状态与验证结果为最新记录。
