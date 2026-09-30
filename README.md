# 实习决策与执行工作台

仓库分为前端应用和 Cloudflare Workers 后端。当前以演示身份和虚构资料运行；模型服务默认使用确定性的 `mock` 适配器。产品目标与验收范围见 [PLAN.md](PLAN.md)，已实现内容和差异见 [计划对照](docs/plan-gap-analysis.md)。

## 目录

```text
.
├── frontend/                 # React + TypeScript + Vite 前端及本地开发代理
│   ├── src/                  # 页面、API 客户端与离线数据
│   └── prototype/            # 早期单文件静态设计稿和预览历史
├── backend/                  # Workers API、D1/R2、Workflows 与测试
│   ├── src/                  # 接口、应用、领域和基础设施层
│   ├── migrations/           # D1 迁移
│   ├── openapi/              # 前后端共享的 API 契约快照
│   └── test/                 # 单元及 Miniflare 集成测试
├── docs/                     # 计划差异与验收记录
├── PLAN.md                   # 产品规格和实施计划
└── backend_plan.md           # 后端实施计划
```

## 本地联调

先在一个终端启动后端：

```sh
cd backend
npm ci
cp -n .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
```

再在另一个终端启动前端：

```sh
cd frontend
npm ci
npm run dev
```

打开 `http://localhost:5173` 并选择演示身份。前端开发服务器将同源的 `/api/v1` 请求代理到 `http://127.0.0.1:8787`，浏览器会随请求发送会话 Cookie。`.dev.vars` 只用于本地且不会提交；若已存在，请保留自己的配置。首次启动后端前需要运行 D1 迁移。后端默认数据库为空，可在页面中创建演示数据。

### 不启动后端的演示模式

前端内置一份演示适配器，与 HTTP 适配器实现同一个数据访问接口，可在没有后端的情况下运行完整界面：

```sh
cd frontend
npm ci
npm run dev:demo    # http://127.0.0.1:5174
```

演示适配器会模拟请求延迟、故障、异步作业、版本冲突与离线同步；设置页的“重置我的演示数据”在演示模式下恢复初始虚构数据，在后端模式下调用 `POST /api/v1/demo/reset`（仅在 `DEMO_ENABLED=true` 时开放）。浏览器联调脚本见 [frontend/e2e](frontend/e2e/README.md)。

## 检查与部署

当前线上演示站（2026-09-30 部署）：

- 前端工作台：<https://intern.greenbp.dpdns.org>（更新既有 `greenbp-intern-workbench` Worker）
- 后端 API：<https://greenbp-intern-workbench-backend.hddhp.workers.dev>（前端通过 Service Binding 以同源 `/api/v1` 访问）

当前 Cloudflare API 已确认前端域名与后端绑定；自动化 HTTP 检查请求前端时收到 Cloudflare 403 安全挑战，线上浏览器流程尚待复验。

部署前先跑只读预检（本地门禁 + 契约快照 + 两个 Worker 的 dry-run + Cloudflare 资源状态）：

```sh
node scripts/deploy-preflight.mjs
```

首次部署：`node scripts/bootstrap-cloudflare.mjs --apply` 创建 D1/R2 并回填 `database_id`，再按
[后端部署文档](backend/docs/deployment.md) 配置迁移与密钥。发布顺序是先部署后端 Worker
`greenbp-intern-workbench-backend`，再部署既有前端 Worker `greenbp-intern-workbench`；前端通过 Service Binding 把同源 `/api/v1` 请求转发到后端，
保证演示会话 Cookie 正常工作。部署后用
`node backend/scripts/smoke-deploy.mjs <后端地址>` 冒烟。

也可以分别手动执行：在 `backend/` 运行 `npm run typecheck` 和 `npm test`；在 `frontend/` 运行
`npm run typecheck`、`npm run lint`、`npm test` 和 `npm run build`。真实 Cloudflare 环境、真实模型
及浏览器推送的验证状态见 [计划对照](docs/plan-gap-analysis.md) 与
[部署文档](backend/docs/deployment.md)。
