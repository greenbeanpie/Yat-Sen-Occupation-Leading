import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from './client';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('API session and conflict handling', () => {
  it('sends session cookies to the same-origin API', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ authenticated: false }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api('/session')).resolves.toEqual({ authenticated: false });
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/session', expect.objectContaining({ credentials: 'include' }));
  });

  it('preserves the current server record from a version conflict response', async () => {
    const serverRecord = { id: 'profile-id', version: 4, targetRoles: ['设计实习生'] };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: {
        code: 'version_conflict',
        message: '画像已被其他修改更新',
        server: serverRecord,
      },
    }), {
      status: 409,
      headers: { 'content-type': 'application/json' },
    })));

    await expect(api('/profile')).rejects.toMatchObject({
      name: 'ApiError',
      status: 409,
      code: 'version_conflict',
      serverRecord,
    } satisfies Partial<ApiError>);
  });

  it('returns undefined for successful empty responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    await expect(api('/session', { method: 'DELETE' })).resolves.toBeUndefined();
  });
});
