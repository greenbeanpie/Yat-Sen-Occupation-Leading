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

## 检查与部署

在 `backend/` 运行 `npm run typecheck` 和 `npm test`；在 `frontend/` 运行 `npm run typecheck`、`npm test` 和 `npm run build`。前端及后端分别部署：先部署后端 Worker `yso-backend`，再部署前端 Worker。前端通过 Cloudflare Service Binding 将同源 `/api/v1` 请求转发到后端，保证演示会话 Cookie 正常工作；本地开发由 Vite 代理同一路径。部署前需配置 Cloudflare D1、私有 R2、Workflows、环境变量与密钥；步骤见 [后端部署文档](backend/docs/deployment.md)。真实 Cloudflare 环境、真实模型及浏览器推送的验证状态见 [计划对照](docs/plan-gap-analysis.md)。
