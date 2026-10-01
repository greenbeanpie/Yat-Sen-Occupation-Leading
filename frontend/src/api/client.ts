import type { paths } from './schema';
import { transport } from './transport';

export type ApiPath = keyof paths;
export type JsonRecord = Record<string, unknown>;

const BASE = (import.meta.env.VITE_API_BASE ?? '/api/v1').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly payload: unknown,
    public readonly code?: string,
    public readonly serverRecord?: unknown,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function messageFrom(payload: unknown, fallback: string): { message: string; code?: string; server?: unknown } {
  if (!payload || typeof payload !== 'object') return { message: fallback };
  const error = (payload as { error?: unknown }).error;
  if (!error || typeof error !== 'object') return { message: fallback };
  const body = error as { message?: unknown; code?: unknown; server?: unknown; details?: unknown };
  const details = Array.isArray(body.details)
    ? body.details.flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const detail = item as { field?: unknown; issue?: unknown };
        const field = String(detail.field ?? '字段');
        const labels: Record<string, string> = { invitationCode: '邀请码', username: '用户名', password: '密码', email: '邮箱', displayName: '昵称' };
        return [`${labels[field] ?? field}: ${String(detail.issue ?? '无效')}`];
      })
    : [];
  const message = typeof body.message === 'string' ? body.message : fallback;
  return {
    message: [message, ...details].join('；'),
    code: typeof body.code === 'string' ? body.code : undefined,
    server: body.server,
  };
}

export async function api<T = unknown>(path: string, init: RequestInit = {}, followPages = true): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  let response: Response;
  try {
    response = await transport(`${BASE}${path}`, {
      ...init,
      headers,
      // The development proxy keeps API requests same-origin so the backend's
      // SameSite=Lax session cookie is sent by the browser.
      credentials: 'include',
    });
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error('网络不可用，请检查连接后重试。');
  }

  if (response.status === 204) return undefined as T;

  const contentType = response.headers.get('content-type') ?? '';
  const payload = contentType.includes('application/json')
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    if (response.status === 403 && (response.headers.get('cf-mitigated') === 'challenge' || (contentType.includes('text/html') && typeof payload === 'string' && /cloudflare|cf-chl|just a moment/i.test(payload)))) {
      throw new ApiError('Cloudflare 安全验证拦截了请求。请在普通浏览器打开本站完成验证，再刷新重试；若持续出现，请联系站点管理员。', 403, undefined, 'security_challenge');
    }
    const parsed = messageFrom(payload, `请求失败 (${response.status})`);
    throw new ApiError(parsed.message, response.status, payload, parsed.code, parsed.server,response.headers.get('X-Request-Id')??undefined);
  }

  // Existing screens consume complete lists; transparently follow advertised pages.
  if (followPages && (init.method ?? 'GET') === 'GET' && payload && typeof payload === 'object' && 'items' in payload && Array.isArray(payload.items) && 'nextCursor' in payload && typeof payload.nextCursor === 'string') {
    const url = new URL(path, 'https://pagination.local');
    url.searchParams.set('cursor', payload.nextCursor);
    const next = await api<{ items: unknown[]; nextCursor?: string | null }>(url.pathname + url.search, init);
    return { ...payload, items: [...payload.items, ...next.items], nextCursor: next.nextCursor ?? null } as T;
  }
  return payload as T;
}

export const get = <T = unknown>(path: string, init?: RequestInit) => api<T>(path, init);
/** Fetch one page when the screen explicitly controls loading further records. */
export const getPage = <T = unknown>(path: string, init?: RequestInit) => api<T>(path, init, false);
export const post = <T = unknown>(path: string, body?: unknown) =>
  api<T>(path, { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
export const put = <T = unknown>(path: string, body: unknown) =>
  api<T>(path, { method: 'PUT', body: JSON.stringify(body) });
export const patch = <T = unknown>(path: string, body: unknown) =>
  api<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
export const del = <T = unknown>(path: string) => api<T>(path, { method: 'DELETE' });

export interface Operation {
  id: string;
  type: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  error?: string | null;
  resultRef?: string | null;
}

export async function pollOperation(
  id: string,
  onTick?: (status: Operation['status']) => void,
): Promise<Operation> {
  const deadline = Date.now() + 5 * 60_000;
  let delay = 800;
  while (Date.now() < deadline) {
    const operation = await get<Operation>(`/operations/${id}`);
    onTick?.(operation.status);
    if (operation.status === 'succeeded') return operation;
    if (operation.status === 'failed') {
      throw new Error(operation.error || '后台处理失败，请检查输入后重试。');
    }
    await new Promise((resolve) => window.setTimeout(resolve, delay));
    delay = Math.min(4_000, Math.round(delay * 1.25));
  }
  throw new Error('后台仍在处理。请稍后刷新作业状态，避免重复提交。');
}

export type OpenApiPaths = paths;
