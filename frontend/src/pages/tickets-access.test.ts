import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getPage } from '../api/client';
import { readTicketPage, ticketAccessScope, TicketSessionChanged, type TicketSession } from './tickets-access';
import type { UserRole } from '../roles';

vi.mock('../api/client', () => ({ getPage: vi.fn() }));
const expected = { userId: 'actor', role: 'admin' as const };
const session = (role: 'student' | 'admin' | 'super_admin' = 'admin'): TicketSession => ({ authenticated: true, user: { id: 'actor', role, displayName: '用户', timezone: 'Asia/Shanghai', demo: false } });
const page = { items: [{ id: 'private-ticket' }], nextCursor: 'next' };
const api = vi.mocked(getPage);
beforeEach(() => { api.mockReset(); });

describe('live ticket authorization boundaries', () => {
  it('isolates all three roles for the same user in the resource identity', () => {
    const roles: UserRole[] = ['student', 'admin', 'super_admin'];
    expect(new Set(roles.map(role => ticketAccessScope('actor', role))).size).toBe(3);
  });

  it('checks a no-store session before and after accepting a ticket page', async () => {
    api.mockResolvedValueOnce(session()).mockResolvedValueOnce(page).mockResolvedValueOnce(session());
    await expect(readTicketPage('/tickets?cursor=next', expected, () => true)).resolves.toBe(page);
    expect(api.mock.calls.map(call => call[0])).toEqual(['/session', '/tickets?cursor=next', '/session']);
    for (const call of api.mock.calls) expect(call[1]).toMatchObject({ cache: 'no-store' });
  });

  it('rejects role-changed pagination before requesting or merging another page', async () => {
    api.mockResolvedValueOnce(session('student'));
    await expect(readTicketPage('/tickets?cursor=next', expected, () => true)).rejects.toMatchObject({ session: session('student') });
    expect(api).toHaveBeenCalledTimes(1);
  });

  it('rejects a privileged page if demotion occurs during the request', async () => {
    api.mockResolvedValueOnce(session()).mockResolvedValueOnce(page).mockResolvedValueOnce(session('student'));
    const accept = vi.fn();
    await expect(readTicketPage('/tickets?cursor=next', expected, () => true).then(accept)).rejects.toBeInstanceOf(TicketSessionChanged);
    expect(accept).not.toHaveBeenCalled();
  });

  it('also discovers mid-request demotion when the ticket endpoint rejects access', async () => {
    api.mockResolvedValueOnce(session()).mockRejectedValueOnce(new Error('工单不存在')).mockResolvedValueOnce(session('student'));
    await expect(readTicketPage('/tickets/private/detail', expected, () => true)).rejects.toMatchObject({ session: session('student') });
    expect(api.mock.calls.map(call => call[0])).toEqual(['/session', '/tickets/private/detail', '/session']);
  });

  it('preserves an endpoint error when post-error authorization is unchanged', async () => {
    api.mockResolvedValueOnce(session()).mockRejectedValueOnce(new Error('工单不存在')).mockResolvedValueOnce(session());
    await expect(readTicketPage('/tickets/missing', expected, () => true)).rejects.toThrow('工单不存在');
  });

  it.each<TicketSession>([
    { authenticated: false },
    { ...session(), user: { ...session().user!, id: 'another-user' } },
    { ...session(), user: { ...session().user!, demo: true } },
  ])('rejects logout, user replacement, and demo identities before a read', async value => {
    api.mockResolvedValueOnce(value);
    await expect(readTicketPage('/tickets/detail?before=older', expected, () => true)).rejects.toMatchObject({ session: value });
    expect(api).toHaveBeenCalledTimes(1);
  });

  it('ignores a delayed old session after the role scope changed before effect cleanup', async () => {
    let resolve!: (value: TicketSession) => void;
    api.mockReturnValueOnce(new Promise(resolvePromise => { resolve = resolvePromise; }));
    let activeScope = ticketAccessScope('actor', 'admin');
    const originalScope = activeScope;
    const request = readTicketPage('/tickets?cursor=next', expected, () => activeScope === originalScope);
    activeScope = ticketAccessScope('actor', 'student');
    resolve(session());
    await expect(request).rejects.toThrow('已被更新的页面取代');
    expect(api).toHaveBeenCalledTimes(1);
  });

  it('does not apply delayed old ticket data after a new request generation wins', async () => {
    let resolve!: (value: typeof page) => void;
    api.mockResolvedValueOnce(session()).mockReturnValueOnce(new Promise(resolvePromise => { resolve = resolvePromise; }));
    let active = true;
    const accept = vi.fn();
    const request = readTicketPage('/tickets/detail?before=older', expected, () => active).then(accept);
    await vi.waitFor(() => expect(api).toHaveBeenCalledTimes(2));
    active = false;
    resolve(page);
    await expect(request).rejects.toThrow('已被更新的页面取代');
    expect(accept).not.toHaveBeenCalled();
    expect(api).toHaveBeenCalledTimes(2);
  });

  it('fails closed when the post-read session check cannot be completed', async () => {
    api.mockResolvedValueOnce(session()).mockResolvedValueOnce(page).mockRejectedValueOnce(new Error('网络不可用'));
    await expect(readTicketPage('/tickets', expected, () => true)).rejects.toThrow('网络不可用');
  });
});
