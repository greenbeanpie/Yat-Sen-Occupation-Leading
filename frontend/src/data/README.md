# 演示数据源（PLAN.md 第 4 节：统一数据访问接口的演示适配器）

`src/data/` 实现与 `fetch` 同形的演示传输层：同一套页面、`ApiError`、`pollOperation`
和离线队列代码，可以跑在真实后端（HTTP 适配器）或纯前端演示数据（演示适配器）之上。

## 接线

在 `src/api/client.ts` 里选择数据源，其它文件保持不变：

```ts
import { createDemoTransport } from '../data';

const source = import.meta.env.VITE_DATA_SOURCE ?? 'http';
const transport =
  source === 'demo'
    ? createDemoTransport()
    : (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init);

// api() 内部原来的 fetch(...) 换成 transport(...)
```

登录页始终是默认入口，也提供“游客访问”选项。游客获得独立的学生端虚构数据，保存在当前标签页的 `sessionStorage`；退出、跳离页面或关闭标签页时会清除会话和数据。游客数据不写入后端、`localStorage`、离线缓存或离线同步队列。登录页列出的演示身份仍是开发/演示身份选择，不等同于真实账号认证。

本地切换演示模式：

```sh
# frontend/.env.demo
VITE_DATA_SOURCE=demo

npm run dev -- --mode demo
```

## 覆盖范围

- 与后端同路径、同状态码、同错误码：会话、画像与证据、文档解析、岗位（公共/私人/管理员）、
  匹配与组合、计划与任务与调整建议、改写、投递与面试与工时统计、离线同步协议、提醒与订阅、异步作业。
- 响应结构与 `src/api/schema.ts`（OpenAPI 生成类型）一致，字段漂移会直接变成类型错误。
- 规则沿用 `rules-v1`：硬条件三态（未知不等于通过）、技能覆盖 50% + 已确认证据 30% +
  偏好 20%、组合按单位时间收益排序；模型输出用与后端 `MockProvider` 同形的确定性结果，
  引用必须命中原文。

## 模拟能力（PLAN.md 4）

- **延迟**：`createDemoTransport({ latencyMs, latencyJitterMs })`，默认 120ms + 抖动。
- **失败**：`controls.failNextRequests(n, { status, code, message, offline })`；
  `offline: true` 时抛 `TypeError`，可直接演示离线队列与冲突处理。
- **版本变化与冲突**：所有写入走乐观锁，`baseVersion` 不匹配返回 409 + `server` 记录；
  同步协议返回 `applied / duplicate / conflict / rejected`。演示数据存在 localStorage，
  多标签页共享，因此两个标签页可以真实复现冲突。
- **异步作业**：解析、岗位要求、匹配、计划、改写返回 202 + `operationId`，
  第一次轮询 `running`、第二次完成，与前端 `pollOperation` 的重试节奏一致。
- **固定解析结果只用于配套示例文件**：只有 `示例简历-林晓.pdf`（或文件名含“示例/样例/sample/example”）
  会返回固定草稿，其它文件明确失败并提示手动录入。

## 演示数据与重置

- 初始数据是虚构的：2 个演示学生 + 1 个管理员、1 份画像、2 段经历、3 个技能
  （已确认 / 待确认 / 缺少证据各一）、2 个已发布公共岗位 + 1 个草稿 + 1 个已归档岗位。
- `POST /api/v1/demo/reset`（设置页“重置我的演示数据”）只清空**当前登录的演示身份**的业务数据：
  画像、经历、技能、证据、自建岗位、投递、计划、提醒与同步记录，返回 `{ reset, userId, deletedRows }`，
  与后端同名端点一致；公共岗位库与其他演示身份不受影响。未登录时 `controls.reset()` 清空整份本机演示数据
  （下次读取会重新生成初始虚构数据）。
- 演示能力标记为 `capabilities.demoMode = true`、`push = false`（没有 VAPID 密钥时不做假推送）。

## 测试

```sh
npm test -- src/data
```

覆盖：会话、画像版本冲突、引用核验、示例文件解析与失败态、岗位解析确认与发布、
匹配三态与 `sync_required`、组合排除硬条件不满足的岗位、计划确认与调整建议、
改写采纳写回、投递状态机与效率统计、同步幂等/冲突/删除校验、失败注入、延迟与重置。
