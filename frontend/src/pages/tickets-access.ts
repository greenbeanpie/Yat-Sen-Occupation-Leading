import { getPage } from '../api/client';
import type { components } from '../api/schema';
import type { UserRole } from '../roles';

export type TicketSession = components['schemas']['SessionResponse'];
export interface TicketAccess {
  userId: string;
  role: UserRole;
  onSessionChange: (session: TicketSession) => void;
}

export class TicketSessionChanged extends Error {
  constructor(readonly session: TicketSession) {
    super('账户身份或权限已变化，正在重新加载可访问的工单。');
  }
}

class TicketReadSuperseded extends Error {
  constructor() { super('工单请求已被更新的页面取代。'); }
}

export function ticketAccessScope(userId: string, role: UserRole): string {
  return JSON.stringify([userId, role]);
}

/** Recheck live authorization, and never act on an obsolete session response. */
export async function verifyTicketAccess(
  expected: Pick<TicketAccess, 'userId' | 'role'>,
  isCurrent: () => boolean,
  init?: RequestInit,
): Promise<void> {
  if (!isCurrent()) throw new TicketReadSuperseded();
  const session = await getPage<TicketSession>('/session', { ...init, cache: 'no-store' });
  if (!isCurrent()) throw new TicketReadSuperseded();
  if (!session.authenticated || !session.user || session.user.demo || session.user.id !== expected.userId || session.user.role !== expected.role) {
    throw new TicketSessionChanged(session);
  }
}

/** Both checks are necessary: permissions can change during the ticket request. */
export async function readTicketPage<T>(
  path: string,
  expected: Pick<TicketAccess, 'userId' | 'role'>,
  isCurrent: () => boolean,
  init?: RequestInit,
): Promise<T> {
  await verifyTicketAccess(expected, isCurrent, init);
  let data: T;
  try {
    data = await getPage<T>(path, { ...init, cache: 'no-store' });
  } catch (error) {
    // A 403/404 may itself be the first symptom of a mid-request demotion.
    await verifyTicketAccess(expected, isCurrent, init);
    throw error;
  }
  await verifyTicketAccess(expected, isCurrent, init);
  return data;
}
