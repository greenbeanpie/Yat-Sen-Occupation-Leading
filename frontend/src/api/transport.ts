/**
 * 统一数据访问接口的具体传输层（PLAN.md 4）：
 * - `http`（默认）：真实 `fetch`，请求走 `/api/v1`；
 * - `demo`：前端内置演示适配器，按需异步加载，不发起任何网络请求。
 *
 * 两种实现都是 fetch 形状，因此 `api()`、轮询与离线队列无需感知差异。
 */
export type ApiTransport = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type DataSource = 'http' | 'demo';

export const dataSource: DataSource = import.meta.env.VITE_DATA_SOURCE === 'demo' ? 'demo' : 'http';

let demoTransport: Promise<ApiTransport> | null = null;

async function loadDemoTransport(): Promise<ApiTransport> {
  demoTransport ??= import('../data').then((module) => module.demoTransport());
  return demoTransport;
}

export const transport: ApiTransport = dataSource === 'demo'
  ? async (input, init) => (await loadDemoTransport())(input, init)
  : (input, init) => fetch(input, init);

/** 演示模式下重置本机虚构数据；HTTP 模式返回 false，由调用方走后端接口。 */
export async function resetLocalDemoData(): Promise<boolean> {
  if (dataSource !== 'demo') return false;
  const module = await import('../data');
  module.resetDemoData();
  return true;
}
