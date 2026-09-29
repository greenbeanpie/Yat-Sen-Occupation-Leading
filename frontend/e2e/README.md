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
