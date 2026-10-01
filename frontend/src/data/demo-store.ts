import { buildDemoDatabase } from './demo-seed';
import type { ChangeRecord, DemoDatabase, DemoUser, OperationRecord, ReminderRecord } from './demo-types';

/** 演示数据的最小存储接口；默认实现是 localStorage，测试里用内存实现。 */
export interface DemoStorage {
  read(): string | null;
  write(value: string): void;
  clear(): void;
}

export function createMemoryStorage(): DemoStorage {
  let value: string | null = null;
  return {
    read: () => value,
    write: (next) => {
      value = next;
    },
    clear: () => {
      value = null;
    },
  };
}

export function createBrowserStorage(key: string): DemoStorage {
  return {
    read: () => {
      try {
        return globalThis.localStorage?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    write: (value) => {
      try {
        globalThis.localStorage?.setItem(key, value);
      } catch {
        /* 隐私模式等场景下写入失败：本次会话仍可在内存中继续使用。 */
      }
    },
    clear: () => {
      try {
        globalThis.localStorage?.removeItem(key);
      } catch {
        /* 同上 */
      }
    },
  };
}

/** Guest data exists only in the current tab and is discarded when that tab closes. */
export function createSessionStorage(key: string): DemoStorage {
  let memoryValue: string | null = null;
  return {
    read: () => {
      try {
        return globalThis.sessionStorage?.getItem(key) ?? memoryValue;
      } catch {
        return memoryValue;
      }
    },
    write: (value) => {
      try {
        const storage = globalThis.sessionStorage;
        if (storage) storage.setItem(key, value);
        else memoryValue = value;
      } catch {
        memoryValue = value;
      }
    },
    clear: () => {
      memoryValue = null;
      try {
        globalThis.sessionStorage?.removeItem(key);
      } catch {
        /* The in-memory DemoStore snapshot remains usable for this page. */
      }
    },
  };
}

/**
 * 演示数据库：每次读写都从存储层取最新快照再写回，因此多个标签页共享同一份
 * 演示数据（这也是演示版本冲突的正常前提）。数据量很小，整体序列化足够快。
 */
export class DemoStore {
  /** 重置后跳过当次回写，避免把刚刚清空的内存快照再次写回存储。 */
  private cleared = false;

  constructor(
    private readonly storage: DemoStorage,
    private readonly clock: () => Date,
    private readonly seed: (now: Date) => DemoDatabase = buildDemoDatabase,
  ) {}

  read<T>(fn: (db: DemoDatabase) => T): T {
    return fn(this.load());
  }

  write<T>(fn: (db: DemoDatabase) => T): T {
    const db = this.load();
    const result = fn(db);
    if (this.cleared) this.cleared = false;
    else this.storage.write(JSON.stringify(db));
    return result;
  }

  reset(): void {
    this.storage.clear();
    this.cleared = true;
  }

  now(): Date {
    return this.clock();
  }

  nowIso(): string {
    return this.clock().toISOString();
  }

  /** 本地日期（Asia/Shanghai 演示口径），用于排期与工时统计。 */
  today(): string {
    return this.clock().toISOString().slice(0, 10);
  }

  uuid(): string {
    return globalThis.crypto?.randomUUID?.() ?? fallbackUuid();
  }

  private load(): DemoDatabase {
    const raw = this.storage.read();
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as DemoDatabase;
        if (parsed?.schema === 1 && Array.isArray(parsed.users)) return parsed;
      } catch {
        /* 损坏的演示数据直接回到初始虚构数据。 */
      }
    }
    const seeded = this.seed(this.clock());
    this.storage.write(JSON.stringify(seeded));
    return seeded;
  }
}

function fallbackUuid(): string {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function currentUser(db: DemoDatabase): DemoUser | null {
  if (!db.sessionUserId) return null;
  return db.users.find((user) => user.id === db.sessionUserId) ?? null;
}

export function userById(db: DemoDatabase, id: string): DemoUser | null {
  return db.users.find((user) => user.id === id) ?? null;
}

/** 追加一条变更日志（离线增量同步的数据来源）。 */
export function appendChange(
  db: DemoDatabase,
  entry: Omit<ChangeRecord, 'seq' | 'changedAt'> & { changedAt?: string },
): ChangeRecord {
  db.sequence += 1;
  const change: ChangeRecord = {
    ...entry,
    seq: db.sequence,
    changedAt: entry.changedAt ?? new Date().toISOString(),
  };
  db.changes.push(change);
  return change;
}

export interface DemoEntity {
  id: string;
  version: number;
  deleted: boolean;
  createdAt: string;
  updatedAt: string;
}

export function findById<T extends DemoEntity>(rows: T[], id: string): T | undefined {
  return rows.find((row) => row.id === id);
}

export function createOperation(
  db: DemoDatabase,
  input: {
    id: string;
    userId: string;
    type: OperationRecord['type'];
    payload: Record<string, unknown>;
    createdAt: string;
  },
): OperationRecord {
  const operation: OperationRecord = {
    id: input.id,
    userId: input.userId,
    type: input.type,
    status: 'queued',
    error: null,
    resultRef: null,
    createdAt: input.createdAt,
    input: input.payload,
    polls: 0,
  };
  db.operations.push(operation);
  return operation;
}

/** 演示版“cron”：把到期的待发送提醒标记为已发送，并生成任务/面试提醒。 */
export function materializeReminders(db: DemoDatabase, userId: string, now: Date): ReminderRecord[] {
  const user = userById(db, userId);
  if (!user) return [];
  const nowIso = now.toISOString();
  const today = nowIso.slice(0, 10);
  const activeApplicationIds = new Set(db.applications.filter((row) => row.userId === userId && !row.deleted).map((row) => row.id));

  if (user.notifyTaskDue) {
    const confirmedPlans = new Set(db.plans.filter((plan) => plan.userId === userId && plan.status === 'confirmed').map((plan) => plan.id));
    for (const task of db.tasks) {
      if (task.userId !== userId || task.deleted || !confirmedPlans.has(task.planId)) continue;
      if (task.status !== 'pending' && task.status !== 'in_progress') continue;
      const date = task.scheduledDate;
      if (!date || date > today) continue;
      const fireAt = zonedMorningIso(date, user.timezone, 9);
      if (fireAt > nowIso) continue;
      const dedupeKey = `task-due:${task.id}:${date}`;
      if (db.reminders.some((row) => row.dedupeKey === dedupeKey)) continue;
      db.reminders.push({
        id: randomId(),
        userId,
        status: 'sent',
        dedupeKey,
        kind: 'task_due_9am',
        title: `今日任务：${task.title}`,
        body: `计划日期 ${date}`,
        entity: 'task',
        entityId: task.id,
        fireAt,
        sentAt: nowIso,
        readAt: null,
      });
    }
  }

  if (user.notifyInterview) {
    for (const interview of db.interviews) {
      if (interview.userId !== userId || interview.deleted || !activeApplicationIds.has(interview.applicationId) || interview.scheduledAt <= nowIso) continue;
      const fireAt = new Date(new Date(interview.scheduledAt).getTime() - 3_600_000).toISOString();
      if (fireAt > nowIso) continue;
      const dedupeKey = `interview-1h:${interview.id}`;
      if (db.reminders.some((row) => row.dedupeKey === dedupeKey)) continue;
      db.reminders.push({
        id: randomId(),
        userId,
        status: 'sent',
        dedupeKey,
        kind: 'interview_1h_before',
        title: `面试提醒：${interview.stage || '面试'}`,
        body: '一小时后开始',
        entity: 'interview',
        entityId: interview.id,
        fireAt,
        sentAt: nowIso,
        readAt: null,
      });
    }
  }

  // 待发送但已到期的提醒按 cron 行为升级为已发送。
  for (const reminder of db.reminders) {
    if (reminder.userId !== userId || reminder.status !== 'pending') continue;
    if (reminder.entity === 'interview') {
      const interview = db.interviews.find((row) => row.id === reminder.entityId && row.userId === userId && !row.deleted);
      if (!interview || !activeApplicationIds.has(interview.applicationId)) continue;
    }
    if (reminder.fireAt <= nowIso) {
      reminder.status = 'sent';
      reminder.sentAt = nowIso;
    }
  }
  return db.reminders.filter((row) => row.userId === userId);
}

/** 取消某实体上尚未发送的提醒（改期或完成后）。 */
export function cancelPendingReminders(db: DemoDatabase, userId: string, entity: string, entityId: string): void {
  for (const reminder of db.reminders) {
    if (reminder.userId !== userId || reminder.entity !== entity || reminder.entityId !== entityId) continue;
    if (reminder.status === 'pending') reminder.status = 'cancelled';
  }
}

export function schedulePendingReminder(
  db: DemoDatabase,
  input: { userId: string; entity: 'task' | 'interview'; entityId: string; kind: string; fireAt: string; title: string; body: string; dedupeKey: string },
): void {
  cancelPendingReminders(db, input.userId, input.entity, input.entityId);
  if (db.reminders.some((row) => row.dedupeKey === input.dedupeKey)) return;
  db.reminders.push({
    id: randomId(),
    userId: input.userId,
    status: 'pending',
    dedupeKey: input.dedupeKey,
    kind: input.kind,
    title: input.title,
    body: input.body,
    entity: input.entity,
    entityId: input.entityId,
    fireAt: input.fireAt,
    sentAt: null,
    readAt: null,
  });
}

/** 演示口径的“某地当天 09:00” → UTC ISO；未知时区按 +08:00 处理。 */
export function zonedMorningIso(date: string, timezone: string, hour: number): string {
  const offsetHours = timezone === 'UTC' || timezone === 'Etc/UTC' ? 0 : 8;
  const utc = new Date(`${date}T00:00:00.000Z`).getTime();
  return new Date(utc + (hour - offsetHours) * 3_600_000).toISOString();
}

function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? fallbackUuid();
}
