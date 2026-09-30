import Dexie, { type Table } from 'dexie';
import { get, post } from './api/client';
import type { components } from './api/schema';
import { isGuestUserId } from './guest-mode';

export type SyncEntity =
  | 'profile'
  | 'experience'
  | 'skill'
  | 'evidence'
  | 'job'
  | 'portfolio'
  | 'task'
  | 'application'
  | 'application_event'
  | 'interview'
  | 'time_entry';

export interface QueuedOperation {
  opId: string;
  userId: string;
  entity: SyncEntity;
  entityId: string;
  baseVersion: number;
  action: 'upsert' | 'delete';
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface CachedValue {
  key: string;
  value: unknown;
  updatedAt: string;
}

export interface SyncConflict {
  opId: string;
  userId: string;
  op: QueuedOperation;
  status: 'conflict' | 'rejected';
  serverRecord?: unknown;
  message: string;
  receivedAt: string;
}

class WorkbenchDB extends Dexie {
  queue!: Table<QueuedOperation, string>;
  cache!: Table<CachedValue, string>;
  conflicts!: Table<SyncConflict, string>;

  constructor() {
    super('internship-workbench');
    this.version(1).stores({ queue: 'opId,entity,createdAt', cache: 'key' });
    this.version(2).stores({
      queue: 'opId,entity,createdAt',
      cache: 'key',
      conflicts: 'opId,receivedAt',
    });
    this.version(3)
      .stores({
        queue: 'opId,entity,userId,createdAt',
        cache: 'key',
        conflicts: 'opId,userId,receivedAt',
      })
      .upgrade(async (transaction) => {
        // Never infer which demo account owns data created by the old global queue.
        await transaction.table('queue').toCollection().modify((row: Record<string, unknown>) => { row.userId = ''; });
        await transaction.table('conflicts').toCollection().modify((row: Record<string, unknown>) => { row.userId = ''; });
      });
  }
}

export const db = new WorkbenchDB();

export function cacheKey(userId: string, key: string): string {
  return `${userId}:${key}`;
}

function isGuestCacheKey(key: string): boolean {
  return isGuestUserId(key.split(':', 1)[0] ?? '');
}

export function isNetworkError(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof Error && error.name === 'NetworkError');
}

export async function cacheValue<T>(key: string, value: T): Promise<void> {
  if (isGuestCacheKey(key)) return;
  await db.cache.put({ key, value, updatedAt: new Date().toISOString() });
}

export async function readCached<T>(key: string): Promise<T | undefined> {
  if (isGuestCacheKey(key)) return undefined;
  return (await db.cache.get(key))?.value as T | undefined;
}

export async function queueOperation(
  operation: Omit<QueuedOperation, 'opId' | 'createdAt'> & { opId?: string },
): Promise<QueuedOperation> {
  if (isGuestUserId(operation.userId)) {
    throw new Error('游客数据只保存在当前标签页，无法加入持久化离线队列。');
  }
  const row: QueuedOperation = {
    ...operation,
    opId: operation.opId ?? crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };
  await db.queue.put(row);
  return row;
}

export async function removeQueuedOperation(opId: string): Promise<void> {
  await db.queue.delete(opId);
  await db.conflicts.delete(opId);
}

export async function queueCount(userId: string): Promise<number> {
  if (isGuestUserId(userId)) return 0;
  return db.queue.where('userId').equals(userId).count();
}

export async function listUserConflicts(userId: string): Promise<SyncConflict[]> {
  if (isGuestUserId(userId)) return [];
  return db.conflicts.where('userId').equals(userId).toArray();
}

/** Removes any older guest cache/queue rows when ending an ephemeral session. */
export async function clearGuestOfflineData(userId: string): Promise<void> {
  if (!isGuestUserId(userId)) return;
  await Promise.all([
    db.queue.where('userId').equals(userId).delete(),
    db.conflicts.where('userId').equals(userId).delete(),
    db.cache.where('key').startsWith(`${userId}:`).delete(),
  ]);
}

export async function orphanedOperationCount(): Promise<number> {
  const [queue, conflicts] = await Promise.all([
    db.queue.where('userId').equals('').count(),
    db.conflicts.where('userId').equals('').count(),
  ]);
  return queue + conflicts;
}

export async function clearOrphanedOperations(): Promise<void> {
  await db.queue.where('userId').equals('').delete();
  await db.conflicts.where('userId').equals('').delete();
}

export async function withOfflineQueue(
  onlineAction: () => Promise<unknown>,
  operation: Omit<QueuedOperation, 'opId' | 'createdAt'>,
  updateLocalSnapshot: () => Promise<void>,
): Promise<void> {
  try {
    await onlineAction();
  } catch (error) {
    if (!isNetworkError(error)) throw error;
    await queueOperation(operation);
    await updateLocalSnapshot();
  }
}

export interface SyncSummary {
  submitted: number;
  pending: number;
  conflicts: number;
  cursor: number;
  lastSyncedAt: string;
}

export async function synchronizeUser(userId: string): Promise<SyncSummary> {
  if (isGuestUserId(userId)) {
    return { submitted: 0, pending: 0, conflicts: 0, cursor: 0, lastSyncedAt: '' };
  }
  const queue = await db.queue.where('userId').equals(userId).toArray();
  let submitted = 0;
  for (let offset = 0; offset < queue.length; offset += 100) {
    const batch = queue.slice(offset, offset + 100);
    const response = await post<components['schemas']['SyncResponse']>('/sync/operations', {
      operations: batch.map(({ createdAt: _createdAt, userId: _userId, ...operation }) => operation),
    });
    for (const result of response.results) {
      const operation = batch.find((candidate) => candidate.opId === result.opId);
      if (!operation) continue;
      if (result.status === 'applied' || result.status === 'duplicate') {
        await db.queue.delete(result.opId);
        submitted += 1;
      } else {
        await db.conflicts.put({
          opId: operation.opId,
          userId,
          op: operation,
          status: result.status,
          serverRecord: result.record,
          message: result.error ?? (result.status === 'conflict' ? '服务端记录已变化。' : '服务端拒绝此操作。'),
          receivedAt: new Date().toISOString(),
        });
        await db.queue.delete(result.opId);
      }
    }
  }

  const cursorKey = cacheKey(userId, 'syncCursor');
  const cursorRow = await db.cache.get(cursorKey);
  let cursor = Number(cursorRow?.value ?? 0);
  let hasMore = true;
  while (hasMore) {
    const changes = await get<components['schemas']['SyncChangesResponse']>(`/sync/changes?since=${cursor}&limit=100`);
    cursor = changes.cursor;
    hasMore = changes.hasMore;
    await cacheValue(cursorKey, cursor);
  }

  const lastSyncedAt = new Date().toISOString();
  await cacheValue(cacheKey(userId, 'lastSync'), lastSyncedAt);
  return {
    submitted,
    pending: await queueCount(userId),
    conflicts: (await listUserConflicts(userId)).length,
    cursor,
    lastSyncedAt,
  };
}
