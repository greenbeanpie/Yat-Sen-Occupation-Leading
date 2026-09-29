# 浏览器联调脚本

两个脚本都用无头 Chromium 驱动真实前端，检查 `/api/v1` 的真实往返，不 mock 接口。

## 前置条件

1. 后端：`cd backend && npm run db:migrate:local && npm run dev`（默认 `http://127.0.0.1:8787`）
2. 前端：`cd frontend && npm run dev`（默认 `http://127.0.0.1:5173`，并把 `/api/v1` 代理到后端）

脚本复用本机已安装的 `playwright-core` 与 Chromium 缓存，不额外声明 npm 依赖。可用环境变量覆盖：

| 变量 | 作用 |
|---|---|
| `PLAYWRIGHT_CORE` | `playwright-core` 入口文件路径 |
| `CHROMIUM_PATH` | Chromium 可执行文件路径 |
| `WORKBENCH_URL` | 前端地址，默认 `http://127.0.0.1:5173` |

## 运行

```bash
cd frontend
npm run e2e             # 主流程：画像→证据→岗位→匹配→计划→改写→投递→离线同步→管理员
npm run e2e:responsive  # 移动端布局与深链接刷新
```

截图写入 `e2e/.artifacts/`（已忽略）。脚本会创建真实演示数据，包括带时间戳的私人岗位、经历与投递记录；重复运行不会互相覆盖。离线步骤会短暂把浏览器切到离线状态，控制台出现 `ERR_INTERNET_DISCONNECTED` 属于预期。

脚本默认访问 `http://127.0.0.1:5173`（Vite 开发服务器）。也可以用 `WORKBENCH_URL` 指向构建产物或前端 Worker，例如验证 Cloudflare 同构路径：

```bash
# 终端 A：同时启动前端 Worker 与后端 Worker（Service Binding 生效）
npx wrangler dev -c frontend/wrangler.jsonc -c backend/wrangler.jsonc --port 8790
# 终端 B
cd frontend && npm run build
WORKBENCH_URL=http://127.0.0.1:8790 npm run e2e
```

## 演示模式（不需要后端）

```bash
cd frontend
npm run dev:demo        # 5174 端口，使用内置演示适配器
npm run e2e:demo        # 无头浏览器验收计划要求的状态分支
```

演示适配器与 HTTP 适配器实现同一个 fetch 形状接口（见 `src/api/transport.ts`），因此页面、轮询和离线队列不需要区分数据源；它可模拟请求延迟、故障、`202 + operationId` 异步作业、409 版本冲突与离线同步去重。

## PWA 更新提示

更新提示只在生产构建中出现（开发服务器不注册 Service Worker）。手工验证：

1. `npm run build && npm run preview`
2. 打开页面并等待 `navigator.serviceWorker.ready`
3. 改动 `index.html` 后再次 `npm run build`，刷新页面
4. 页面顶部出现“工作台有新版本可用”，点击“立即更新”后加载新版本
