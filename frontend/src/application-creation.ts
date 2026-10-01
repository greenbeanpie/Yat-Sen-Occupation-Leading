import { post } from './api/client';
import type { components } from './api/schema';
import { cacheKey, cacheValue, readCached, withOfflineQueue } from './offline';

type Application = components['schemas']['Application'];

export interface ApplicationDraft {
  jobId: string | null;
  jobTitle: string;
  company: string;
  notes: string;
  status: 'preparing';
}

/** One logical submission keeps its identity until the server or durable queue acknowledges it. */
export class CreationAttempt {
  private creationId: string | null = null;
  private pending = false;

  async run(submit: (creationId: string) => Promise<boolean>): Promise<boolean> {
    // React state updates alone do not guard two events in the same render.
    if (this.pending) return false;
    this.pending = true;
    try {
      this.creationId ??= crypto.randomUUID();
      const saved = await submit(this.creationId);
      if (saved) this.creationId = null;
      return saved;
    } finally {
      this.pending = false;
    }
  }
}

export async function createTrackedApplication(userId: string, creationId: string, draft: ApplicationDraft): Promise<void> {
  const payload = { ...draft, creationId };
  return withOfflineQueue(
    () => post('/applications', payload),
    { opId: creationId, userId, entity: 'application', entityId: creationId, baseVersion: 0, action: 'upsert', payload },
    async () => {
      const now = new Date().toISOString();
      const local: Application = {
        ...draft, jobId: draft.jobId ?? undefined, id: creationId, version: 0, deleted: false, userId,
        createdAt: now, updatedAt: now,
      };
      const key = cacheKey(userId, 'api:/applications');
      const cached = await readCached<{ items: Application[] }>(key);
      await cacheValue(key, { items: [local, ...(cached?.items ?? []).filter((item) => item.id !== creationId)] });
    },
  );
}
