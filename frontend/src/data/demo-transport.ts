import { createBrowserStorage, createMemoryStorage, createSessionStorage, DemoStore } from './demo-store';
import { handleDemoRequest } from './demo-api';
import { DemoApiError, type DemoControls, type DemoFailure, type DemoTransport, type DemoTransportOptions } from './demo-types';

export const DEMO_STORAGE_KEY = 'yso.workbench.demo.v1';
export const DEMO_BASE_PATH = '/api/v1';

const DEFAULT_FAILURE: DemoFailure = {
  status: 503,
  code: 'network_unavailable',
  message: '演示数据源模拟的服务端故障',
  offline: false,
};

export interface DemoTransportHandle extends DemoTransport {
  readonly kind: 'demo';
  readonly controls: DemoControls;
}

/**
 * 建立演示数据源：接口形态与 `fetch` 相同，因此可以直接替换 HTTP 适配器，
 * `ApiError`、`pollOperation`、离线队列等既有代码不需要改动。
 *
 * 模拟能力（PLAN.md 4）：请求延迟、队列/失败注入、202 异步作业、
 * 版本冲突（409 + server 记录）、离线同步去重与墓碑、冲突回执。
 */
export function createDemoTransport(options: DemoTransportOptions = {}): DemoTransportHandle {
  const storage = options.sessionOnly
    ? createSessionStorage(options.storageKey ?? DEMO_STORAGE_KEY)
    : options.persist === false
      ? createMemoryStorage()
      : createBrowserStorage(options.storageKey ?? DEMO_STORAGE_KEY);
  const store = new DemoStore(storage, options.now ?? (() => new Date()), options.seed);
  let latency = Math.max(0, options.latencyMs ?? 120);
  let jitter = Math.max(0, options.latencyJitterMs ?? 80);
  let pendingFailures = Math.max(0, options.failNextRequests ?? 0);
  let failure: DemoFailure = { ...DEFAULT_FAILURE, ...(options.failure ?? {}) };

  const controls: DemoControls = {
    failNextRequests(count = 1, override) {
      pendingFailures = Math.max(0, count);
      failure = { ...failure, ...(override ?? {}) };
    },
    setLatency(latencyMs, jitterMs = 0) {
      latency = Math.max(0, latencyMs);
      jitter = Math.max(0, jitterMs);
    },
    reset() {
      const session = store.read((db) => db.sessionUserId);
      if (session) {
        // 已登录：只重置当前演示身份（公共岗位库与其他身份保留）。
        handleDemoRequest(store, {
          method: 'POST',
          path: '/demo/reset',
          query: new URLSearchParams(),
          body: null,
          formData: null,
          userId: null,
        });
      } else {
        store.reset();
      }
      pendingFailures = 0;
    },
    currentUser() {
      return store.read((db) => db.sessionUserId);
    },
  };

  const transport = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), 'https://demo.local');
    const path = normalizePath(url.pathname);
    const method = (init.method ?? 'GET').toUpperCase();

    await delay(latency + Math.round(Math.random() * jitter));

    if (pendingFailures > 0) {
      pendingFailures -= 1;
      if (failure.offline) throw new TypeError('Failed to fetch');
      return errorResponse(failure.status, failure.code, failure.message);
    }

    try {
      const { body, formData } = parseBody(init.body, init.headers);
      const result = handleDemoRequest(store, {
        method,
        path,
        query: url.searchParams,
        body,
        formData,
        userId: null,
      });
      return toResponse(result);
    } catch (error) {
      if (error instanceof DemoApiError) {
        return errorResponse(error.status, error.code, error.message, error.details, error.server);
      }
      return errorResponse(500, 'operation_failed', error instanceof Error ? error.message : '演示数据源错误');
    }
  }) as DemoTransportHandle;

  return Object.assign(transport, { kind: 'demo' as const, controls });
}

function normalizePath(pathname: string): string {
  const withoutBase = pathname.startsWith(DEMO_BASE_PATH) ? pathname.slice(DEMO_BASE_PATH.length) : pathname;
  if (!withoutBase) return '/';
  return withoutBase.startsWith('/') ? withoutBase : `/${withoutBase}`;
}

function parseBody(body: BodyInit | null | undefined, headers: HeadersInit | undefined): { body: unknown; formData: FormData | null } {
  if (body === undefined || body === null) return { body: null, formData: null };
  if (typeof FormData !== 'undefined' && body instanceof FormData) return { body: null, formData: body };
  if (typeof body === 'string') {
    try {
      return { body: JSON.parse(body) as unknown, formData: null };
    } catch {
      return { body: body, formData: null };
    }
  }
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
    return { body: Object.fromEntries(body.entries()), formData: null };
  }
  void headers;
  return { body: null, formData: null };
}

function toResponse(result: { status: number; body?: unknown }): Response {
  if (result.status === 204 || result.body === undefined) return new Response(null, { status: result.status });
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { 'content-type': 'application/json' },
  });
}

function errorResponse(status: number, code: string, message: string, details?: unknown, server?: unknown): Response {
  return new Response(
    JSON.stringify({
      error: {
        code,
        message,
        ...(details === undefined ? {} : { details }),
        ...(server === undefined ? {} : { server }),
      },
    }),
    { status, headers: { 'content-type': 'application/json' } },
  );
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
