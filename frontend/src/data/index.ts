/**
 * 演示数据源（PLAN.md 4：统一数据访问接口的演示适配器）。
 *
 * 用法（由 `src/api/client.ts` 负责接线）：
 *
 * ```ts
 * const transport = import.meta.env.VITE_DATA_SOURCE === 'demo'
 *   ? createDemoTransport()
 *   : (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init);
 * ```
 *
 * 演示数据默认写入 localStorage（键名 `yso.workbench.demo.v1`），
 * 可通过 `controls.reset()` 或 `POST /demo/reset` 恢复初始虚构数据。
 */

export { createDemoTransport, DEMO_BASE_PATH, DEMO_STORAGE_KEY, type DemoTransportHandle } from './demo-transport';
export { createBrowserStorage, createMemoryStorage, DemoStore } from './demo-store';
export { DEMO_USER_IDS, EXAMPLE_RESUME_FILENAME, EXAMPLE_RESUME_TEXT, isExampleResume } from './demo-seed';
export { DemoApiError, type DemoControls, type DemoFailure, type DemoTransport, type DemoTransportOptions } from './demo-types';

import { createDemoTransport, type DemoTransportHandle } from './demo-transport';

let shared: DemoTransportHandle | null = null;

/** 应用共用的演示数据源单例；同一标签页内共享同一份演示会话。 */
export function demoTransport(): DemoTransportHandle {
  shared ??= createDemoTransport();
  return shared;
}

/** 恢复初始虚构数据（等价于演示设置页的“重置演示数据”）。 */
export function resetDemoData(): void {
  demoTransport().controls.reset();
}
