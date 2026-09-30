import { useEffect, useRef, useState } from 'react';
import type { components } from '../api/schema';
import { readTicketPage, ticketAccessScope, TicketSessionChanged, verifyTicketAccess, type TicketAccess } from './tickets-access';

export type TicketSummary = components['schemas']['SupportTicket'];
export type TicketStatus = TicketSummary['status'];
export type TicketMessage = components['schemas']['SupportTicketMessage'];
export type TicketDetail = components['schemas']['SupportTicketDetail'];
export type TicketList = components['schemas']['SupportTicketList'];

export const ticketStatuses: { value: TicketStatus; label: string }[] = [
  { value: 'pending', label: '待处理' },
  { value: 'in_progress', label: '处理中' },
  { value: 'waiting_user', label: '等待用户回复' },
  { value: 'resolved', label: '已解决' },
  { value: 'closed', label: '已关闭' },
];

export function ticketStatusLabel(status: TicketStatus) {
  return ticketStatuses.find(option => option.value === status)?.label ?? status;
}

/** Keep chronological/list ordering while replacing duplicate records in place. */
export function mergeTicketRecords<T extends { id: string }>(first: T[], second: T[]): T[] {
  return Array.from(new Map([...first, ...second].map(item => [item.id, item])).values());
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : '工单加载失败，请重试。';
}

export function useTicketList(access: TicketAccess, refresh: number): {
  data: TicketList | null; loading: boolean; loadingMore: boolean; error: string; loadMore: () => Promise<void>;
} {
  const { userId, role } = access;
  const scope = `${ticketAccessScope(userId, role)}:${refresh}`;
  const activeScope = useRef(scope);
  activeScope.current = scope;
  const onSessionChange = useRef(access.onSessionChange);
  onSessionChange.current = access.onSessionChange;
  const [state, setState] = useState<{ scope: string; data: TicketList | null; loading: boolean; loadingMore: boolean; error: string }>({ scope, data: null, loading: true, loadingMore: false, error: '' });
  const generation = useRef<object>({});
  const paging = useRef(false);
  useEffect(() => {
    const current = {};
    generation.current = current;
    const controller = new AbortController();
    paging.current = false;
    setState({ scope, data: null, loading: true, loadingMore: false, error: '' });
    const isCurrent = () => current === generation.current && activeScope.current === scope;
    readTicketPage<TicketList>('/tickets?limit=20', { userId, role }, isCurrent, { signal: controller.signal })
      .then(data => { if (isCurrent()) setState({ scope, data, loading: false, loadingMore: false, error: '' }); })
      .catch((value: unknown) => {
        if (!controller.signal.aborted && isCurrent()) {
          generation.current = {};
          setState({ scope, data: null, loading: false, loadingMore: false, error: errorMessage(value) });
          if (value instanceof TicketSessionChanged) onSessionChange.current(value.session);
        }
      });
    return () => { generation.current = {}; controller.abort(); };
  }, [scope, userId, role]);

  async function loadMore() {
    if (paging.current || state.scope !== scope || !state.data?.nextCursor) return;
    const current = generation.current;
    const isCurrent = () => current === generation.current && activeScope.current === scope;
    paging.current = true;
    setState(previous => ({ ...previous, loadingMore: true, error: '' }));
    try {
      const next = await readTicketPage<TicketList>(`/tickets?limit=20&cursor=${encodeURIComponent(state.data.nextCursor)}`, { userId, role }, isCurrent);
      if (isCurrent()) setState(previous => ({ ...previous, loadingMore: false, data: { items: mergeTicketRecords(previous.data?.items ?? [], next.items), nextCursor: next.nextCursor } }));
    } catch (value) {
      if (isCurrent()) {
        generation.current = {}; paging.current = false;
        setState(previous => ({ ...previous, loadingMore: false, data: null, error: errorMessage(value) }));
        if (value instanceof TicketSessionChanged) onSessionChange.current(value.session);
      }
    } finally { if (isCurrent()) paging.current = false; }
  }
  return { ...(state.scope === scope ? state : { data: null, loading: true, loadingMore: false, error: '' }), loadMore };
}

export function useTicketDetail(access: TicketAccess, id: string, refresh: number): {
  data: TicketDetail | null; loading: boolean; loadingOlder: boolean; error: string;
  loadOlder: () => Promise<void>; replace: (data: TicketDetail) => Promise<boolean>;
} {
  const { userId, role } = access;
  const scope = `${ticketAccessScope(userId, role)}:${id}:${refresh}`;
  const activeScope = useRef(scope);
  activeScope.current = scope;
  const onSessionChange = useRef(access.onSessionChange);
  onSessionChange.current = access.onSessionChange;
  const [state, setState] = useState<{ scope: string; data: TicketDetail | null; loading: boolean; loadingOlder: boolean; error: string }>({ scope, data: null, loading: true, loadingOlder: false, error: '' });
  const generation = useRef<object>({});
  const paging = useRef(false);
  useEffect(() => {
    const current = {};
    generation.current = current;
    const controller = new AbortController();
    paging.current = false;
    setState({ scope, data: null, loading: true, loadingOlder: false, error: '' });
    const isCurrent = () => current === generation.current && activeScope.current === scope;
    readTicketPage<TicketDetail>(`/tickets/${encodeURIComponent(id)}?limit=50`, { userId, role }, isCurrent, { signal: controller.signal })
      .then(data => { if (isCurrent()) setState({ scope, data, loading: false, loadingOlder: false, error: '' }); })
      .catch((value: unknown) => {
        if (!controller.signal.aborted && isCurrent()) {
          generation.current = {};
          setState({ scope, data: null, loading: false, loadingOlder: false, error: errorMessage(value) });
          if (value instanceof TicketSessionChanged) onSessionChange.current(value.session);
        }
      });
    return () => { generation.current = {}; controller.abort(); };
  }, [scope, userId, role, id]);

  async function loadOlder() {
    if (paging.current || state.scope !== scope || !state.data?.messagesNextCursor) return;
    const current = generation.current;
    const isCurrent = () => current === generation.current && activeScope.current === scope;
    paging.current = true;
    setState(previous => ({ ...previous, loadingOlder: true, error: '' }));
    try {
      const next = await readTicketPage<TicketDetail>(`/tickets/${encodeURIComponent(id)}?limit=50&before=${encodeURIComponent(state.data.messagesNextCursor)}`, { userId, role }, isCurrent);
      if (isCurrent()) setState(previous => ({ ...previous, loadingOlder: false, data: { ...next, messages: mergeTicketRecords(next.messages, previous.data?.messages ?? []) } }));
    } catch (value) {
      if (isCurrent()) {
        generation.current = {}; paging.current = false;
        setState(previous => ({ ...previous, loadingOlder: false, data: null, error: errorMessage(value) }));
        if (value instanceof TicketSessionChanged) onSessionChange.current(value.session);
      }
    } finally { if (isCurrent()) paging.current = false; }
  }

  async function replace(data: TicketDetail): Promise<boolean> {
    const current = {};
    const replacementScope = activeScope.current;
    // A callback from an old role must never replace the current role's data.
    if (!replacementScope.startsWith(`${ticketAccessScope(userId, role)}:${id}:`)) return false;
    generation.current = current;
    paging.current = false;
    const isCurrent = () => generation.current === current && activeScope.current === replacementScope;
    try {
      await verifyTicketAccess({ userId, role }, isCurrent);
      if (!isCurrent()) return false;
      setState({ scope: replacementScope, data, loading: false, loadingOlder: false, error: '' });
      return true;
    } catch (value) {
      if (isCurrent()) {
        generation.current = {};
        setState({ scope: replacementScope, data: null, loading: false, loadingOlder: false, error: errorMessage(value) });
        if (value instanceof TicketSessionChanged) onSessionChange.current(value.session);
      }
      return false;
    }
  }
  return { ...(state.scope === scope ? state : { data: null, loading: true, loadingOlder: false, error: '' }), loadOlder, replace };
}
