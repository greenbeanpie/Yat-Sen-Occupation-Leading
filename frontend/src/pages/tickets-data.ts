import { useEffect, useRef, useState } from 'react';
import { ApiError, getPage } from '../api/client';
import type { components } from '../api/schema';

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

function accessDenied(value: unknown): boolean {
  return value instanceof ApiError && [401, 403, 404].includes(value.status);
}

export function useTicketList(userId: string, refresh: number): {
  data: TicketList | null; loading: boolean; loadingMore: boolean; error: string; loadMore: () => Promise<void>;
} {
  const scope = `${userId}:${refresh}`;
  const [state, setState] = useState<{ scope: string; data: TicketList | null; loading: boolean; loadingMore: boolean; error: string }>({ scope, data: null, loading: true, loadingMore: false, error: '' });
  const generation = useRef<object>({});
  const paging = useRef(false);
  useEffect(() => {
    const current = {};
    generation.current = current;
    const controller = new AbortController();
    paging.current = false;
    setState({ scope, data: null, loading: true, loadingMore: false, error: '' });
    getPage<TicketList>('/tickets?limit=20', { cache: 'no-store', signal: controller.signal })
      .then(data => { if (current === generation.current) setState({ scope, data, loading: false, loadingMore: false, error: '' }); })
      .catch((value: unknown) => { if (!controller.signal.aborted && current === generation.current) setState({ scope, data: null, loading: false, loadingMore: false, error: errorMessage(value) }); });
    return () => { generation.current = {}; controller.abort(); };
  }, [scope]);

  async function loadMore() {
    if (paging.current || state.scope !== scope || !state.data?.nextCursor) return;
    const current = generation.current;
    paging.current = true;
    setState(previous => ({ ...previous, loadingMore: true, error: '' }));
    try {
      const next = await getPage<TicketList>(`/tickets?limit=20&cursor=${encodeURIComponent(state.data.nextCursor)}`, { cache: 'no-store' });
      if (current === generation.current) setState(previous => ({ ...previous, loadingMore: false, data: { items: mergeTicketRecords(previous.data?.items ?? [], next.items), nextCursor: next.nextCursor } }));
    } catch (value) {
      if (current === generation.current) setState(previous => ({ ...previous, loadingMore: false, data: accessDenied(value) ? null : previous.data, error: errorMessage(value) }));
    } finally { if (current === generation.current) paging.current = false; }
  }
  return { ...(state.scope === scope ? state : { data: null, loading: true, loadingMore: false, error: '' }), loadMore };
}

export function useTicketDetail(userId: string, id: string, refresh: number): {
  data: TicketDetail | null; loading: boolean; loadingOlder: boolean; error: string;
  loadOlder: () => Promise<void>; replace: (data: TicketDetail) => void;
} {
  const scope = `${userId}:${id}:${refresh}`;
  const activeScope = useRef(scope);
  activeScope.current = scope;
  const [state, setState] = useState<{ scope: string; data: TicketDetail | null; loading: boolean; loadingOlder: boolean; error: string }>({ scope, data: null, loading: true, loadingOlder: false, error: '' });
  const generation = useRef<object>({});
  const paging = useRef(false);
  useEffect(() => {
    const current = {};
    generation.current = current;
    const controller = new AbortController();
    paging.current = false;
    setState({ scope, data: null, loading: true, loadingOlder: false, error: '' });
    getPage<TicketDetail>(`/tickets/${encodeURIComponent(id)}?limit=50`, { cache: 'no-store', signal: controller.signal })
      .then(data => { if (current === generation.current) setState({ scope, data, loading: false, loadingOlder: false, error: '' }); })
      .catch((value: unknown) => { if (!controller.signal.aborted && current === generation.current) setState({ scope, data: null, loading: false, loadingOlder: false, error: errorMessage(value) }); });
    return () => { generation.current = {}; controller.abort(); };
  }, [scope, id]);

  async function loadOlder() {
    if (paging.current || state.scope !== scope || !state.data?.messagesNextCursor) return;
    const current = generation.current;
    paging.current = true;
    setState(previous => ({ ...previous, loadingOlder: true, error: '' }));
    try {
      const next = await getPage<TicketDetail>(`/tickets/${encodeURIComponent(id)}?limit=50&before=${encodeURIComponent(state.data.messagesNextCursor)}`, { cache: 'no-store' });
      if (current === generation.current) setState(previous => ({ ...previous, loadingOlder: false, data: { ...next, messages: mergeTicketRecords(next.messages, previous.data?.messages ?? []) } }));
    } catch (value) {
      if (current === generation.current) setState(previous => ({ ...previous, loadingOlder: false, data: accessDenied(value) ? null : previous.data, error: errorMessage(value) }));
    } finally { if (current === generation.current) paging.current = false; }
  }

  function replace(data: TicketDetail) {
    generation.current = {};
    paging.current = false;
    setState({ scope: activeScope.current, data, loading: false, loadingOlder: false, error: '' });
  }
  return { ...(state.scope === scope ? state : { data: null, loading: true, loadingOlder: false, error: '' }), loadOlder, replace };
}
