import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from './client';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('API session and conflict handling', () => {
  it('labels invitation validation errors for the registration form', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: {
      code: 'invalid_request', message: '无法注册', details: [{ field: 'invitationCode', issue: '邀请码已使用' }],
    } }), { status: 422, headers: { 'content-type': 'application/json' } })));
    await expect(api('/session/register')).rejects.toMatchObject({ status: 422, message: '无法注册；邀请码: 邀请码已使用' });
  });
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
  it('recognizes Cloudflare challenges without discarding ordinary authorization errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('<html>Just a moment Cloudflare</html>', { status: 403, headers: { 'content-type': 'text/html', 'cf-mitigated': 'challenge' } })).mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'forbidden', message: '仅管理员可执行' } }), { status: 403, headers: { 'content-type': 'application/json' } })));
    await expect(api('/profile')).rejects.toMatchObject({ code: 'security_challenge' });
    await expect(api('/admin/jobs')).rejects.toMatchObject({ code: 'forbidden', message: '仅管理员可执行' });
  });
  it('follows list pages and preserves filters', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ id: 'a' }], nextCursor: '100' }), { headers: { 'content-type': 'application/json' } })).mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ id: 'b' }], nextCursor: null }), { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    await expect(api('/jobs?scope=mine&q=React')).resolves.toMatchObject({ items: [{ id: 'a' }, { id: 'b' }], nextCursor: null });
    expect(fetch.mock.calls[1]?.[0]).toBe('/api/v1/jobs?scope=mine&q=React&cursor=100');
  });
});
