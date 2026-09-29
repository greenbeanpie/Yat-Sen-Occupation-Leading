# 部署指南与验收状态（M6）

## 一、Cloudflare 资源创建（账号到位后执行一次）

```bash
cd backend
npx wrangler login

# 1. D1 数据库：记下返回的 database_id，替换 wrangler.jsonc 中的 REPLACE_AFTER_D1_CREATE
npx wrangler d1 create yso-db

# 2. R2 私有桶
npx wrangler r2 bucket create yso-docs

# 3. 应用迁移
npm run db:migrate:remote

# 4. Secrets（逐个执行 wrangler secret put <NAME>）
npx wrangler secret put SESSION_SECRET        # openssl rand -hex 32 或任意强随机串
npx wrangler secret put AI_API_KEY            # 若使用真实模型 API
npx wrangler secret put VAPID_PRIVATE_KEY     # npm run generate:vapid 输出的 privateKey
```

`VAPID_PUBLIC_KEY`、`VAPID_SUBJECT` 可放入 `wrangler.jsonc` vars（公钥非敏感），或同样作为 secret。

## 二、部署

```bash
npm run deploy
# Workflows 首次部署后自动注册；Cron 已在 wrangler.jsonc 声明（*/15 * * * *）
```

部署后冒烟：

```bash
curl https://<worker-domain>/api/v1/session
curl -X POST https://<worker-domain>/api/v1/session -H 'Content-Type: application/json' -d '{"userId":"10000000-0000-4000-8000-000000000001"}'
```

## 三、前端联调配置

- 先部署名为 `yso-backend` 的后端 Worker，再部署前端 Worker。前端的 `BACKEND` Service Binding 将同源 `/api/v1/*` 请求转发至后端；会话 Cookie 因此保持同源。若另有直接访问后端的跨域客户端，再把其 Origin 加入 `CORS_ORIGIN` 白名单。
- 契约：`GET /api/v1/openapi.json`，或仓库内 `backend/openapi/openapi.json` 快照生成类型（`openapi-typescript`）；
- 演示模式标识：`GET /api/v1/session` 的 `capabilities.demoMode`。

## 四、验收状态（PLAN.md「组员后端验收」）

| 验收项 | 状态 | 说明 |
|---|---|---|
| PDF/DOCX 文本提取在实际 Cloudflare 环境运行通过 | ⏳ 待账号 | 本地真实 workerd（Miniflare）已通过（[spike 文档](spike-extraction.md)）；真实环境待复测 CPU/内存（R1） |
| 模型响应格式错误、伪造引用、超时、限流和重试得到正确处理 | ✅ 本地通过 | mock 供应商 + 引用核验 + OpenAI 适配器重试逻辑（单元/集成测试覆盖）；真实 API 联调待密钥 |
| 两个真实客户端完成增量同步、幂等提交与冲突解决 | ✅ 本地通过 | 双会话交错编辑测试（test/sync.test.ts）；真实双设备待复测 |
| 私有岗位隔离、管理员权限及未授权文件访问 | ✅ 本地通过 | 跨用户 404/403、角色检查、R2 内容仅本人可读 |
| 真实订阅、后台推送和取消提醒 | ⏳ 部分 | 订阅 CRUD、提醒排期/取消/Cron tick 本地通过；真实浏览器推送需线上 VAPID 配置后验证 |
| 迁移与日志；日志不记录简历正文、模型密钥或完整推送订阅 | ✅ | 迁移脚本化（schema.ts → migrations）；logger 白名单脱敏 |

## 五、未完成项清单

1. **真实 Cloudflare 环境验证**（上表 ⏳ 项）——账号到位后按本文件第一节部署并回填结果。
2. **真实模型 API 联调**——`AI_PROVIDER=openai` + 三件套配置；当前 mock 供应商行为与真实 API 的差异需一轮联调（提示词对齐、JSON 稳定性）。
3. **R1 CPU 风险复测**——30 页 PDF 在免费档 10ms CPU 限制下实测；若超限启用分页拆步预案（代码已按步骤化 Workflow 组织，拆分成本低）。
4. **计划再生成（superseded）**——旧计划保留但「重新生成」入口未做管理端点；当前以多次生成 + 采纳最新实现。
5. **限流**——未实现速率限制（演示范围外，Cloudflare WAF 可选做）。
6. **`.dev.vars` 分发**——SESSION_SECRET 等由部署者自行生成，不入库。
