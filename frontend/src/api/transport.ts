import { currentGuestUserId, isGuestMode, startGuestMode, stopGuestMode } from '../guest-mode';
import { clearGuestOfflineData } from '../offline';

/**
 * 统一数据访问接口的具体传输层（PLAN.md 4）：
 * - `http`（默认）：真实 `fetch`，请求走 `/api/v1`；
 * - `demo`：前端内置演示适配器，按需异步加载，不发起任何网络请求。
 *
 * 两种实现都是 fetch 形状，因此 `api()`、轮询与离线队列无需感知差异。
 */
export type ApiTransport = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type DataSource = 'http' | 'demo';
export type ActiveDataSource = DataSource | 'guest';

export const dataSource: DataSource = import.meta.env.VITE_DATA_SOURCE === 'demo' ? 'demo' : 'http';

let demoTransport: Promise<ApiTransport> | null = null;
let guestTransport: Promise<ApiTransport> | null = null;
let guestTransportUserId: string | null = null;

async function loadDemoTransport(): Promise<ApiTransport> {
  demoTransport ??= import('../data').then((module) => module.demoTransport());
  return demoTransport;
}

async function loadGuestTransport(): Promise<ApiTransport> {
  const userId = currentGuestUserId();
  if (!userId) throw new Error('游客会话已结束，请重新进入游客体验。');
  if (guestTransportUserId !== userId || !guestTransport) {
    guestTransportUserId = userId;
    guestTransport = import('../data').then((module) => module.guestDemoTransport(userId));
  }
  return guestTransport;
}

export function getActiveDataSource(): ActiveDataSource {
  if (isGuestMode()) return 'guest';
  return dataSource;
}

export function beginGuestSession(): string {
  return startGuestMode();
}

export async function endGuestSession(): Promise<void> {
  const userId = stopGuestMode();
  guestTransport = null;
  guestTransportUserId = null;
  if (!userId) return;
  try {
    const data = await import('../data');
    data.clearGuestDemoData(userId);
    await clearGuestOfflineData(userId);
  } catch {
    // The tab-scoped session and guest data were removed synchronously above.
  }
}

export const transport: ApiTransport = async (input, init) => {
  if (isGuestMode()) return (await loadGuestTransport())(input, init);
  if (dataSource === 'demo') return (await loadDemoTransport())(input, init);
  return fetch(input, init);
};

/** 演示模式下重置本机虚构数据；HTTP 模式返回 false，由调用方走后端接口。 */
export async function resetLocalDemoData(): Promise<boolean> {
  const activeDataSource = getActiveDataSource();
  if (activeDataSource === 'guest') {
    const userId = currentGuestUserId();
    if (!userId) return false;
    const module = await import('../data');
    module.guestDemoTransport(userId).controls.reset();
    return true;
  }
  if (activeDataSource !== 'demo') return false;
  const module = await import('../data');
  module.resetDemoData();
  return true;
}
