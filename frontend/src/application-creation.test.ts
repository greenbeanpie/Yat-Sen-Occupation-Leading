import { beforeEach, describe, expect, it, vi } from 'vitest';
import Dexie from 'dexie';
import { CreationAttempt, createTrackedApplication, type ApplicationDraft } from './application-creation';
import { post } from './api/client';
import { db, type CachedValue } from './offline';

vi.mock('./api/client', () => ({ post: vi.fn(), get: vi.fn() }));

const draft: ApplicationDraft = { jobId: null, jobTitle: '工程实习生', company: '示例公司', notes: '第一次申请', status: 'preparing' };

describe('one logical application submission', () => {
  it('locks synchronously so concurrent calls make only one request', async () => {
    const attempt = new CreationAttempt();
    let finish!: (saved: boolean) => void;
    const submit = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const first = attempt.run(submit);
    const duplicate = await attempt.run(submit);
    expect(duplicate).toBe(false);
    expect(submit).toHaveBeenCalledTimes(1);
    finish(true);
    expect(await first).toBe(true);
  });

  it('retains its creation ID after a failed or thrown request and renews it after acknowledgment', async () => {
    const attempt = new CreationAttempt();
    const ids: string[] = [];
    await attempt.run(async (id) => { ids.push(id); return false; });
    await expect(attempt.run(async (id) => { ids.push(id); throw new Error('interrupted'); })).rejects.toThrow('interrupted');
    await attempt.run(async (id) => { ids.push(id); return true; });
    await attempt.run(async (id) => { ids.push(id); return true; });
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).toBe(ids[0]);
    expect(ids[3]).not.toBe(ids[0]);
  });
});

describe('online creation and offline replay use the same identity', () => {
  let snapshot: CachedValue | undefined;
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(post).mockReset();
    snapshot = undefined;
    vi.spyOn(db.queue, 'put').mockResolvedValue('queued');
    vi.spyOn(db.cache, 'get').mockImplementation(() => Dexie.Promise.resolve(snapshot));
    vi.spyOn(db.cache, 'put').mockImplementation((value) => { snapshot = value; return Dexie.Promise.resolve(value.key); });
  });

  it('replays a lost response with the online creation ID as both entity and operation IDs', async () => {
    vi.mocked(post).mockRejectedValue(new TypeError('response lost after commit'));
    const creationId = crypto.randomUUID();
    await createTrackedApplication('student-one', creationId, draft);
    expect(post).toHaveBeenCalledWith('/applications', { ...draft, creationId });
    expect(db.queue.put).toHaveBeenCalledWith(expect.objectContaining({
      opId: creationId, entityId: creationId, entity: 'application',
      payload: { ...draft, creationId }, baseVersion: 0,
    }));
    await createTrackedApplication('student-one', creationId, draft);
    expect((snapshot?.value as { items: unknown[] }).items).toHaveLength(1);
    expect(db.queue.put).toHaveBeenLastCalledWith(expect.objectContaining({ opId: creationId, entityId: creationId }));
  });

  it('keeps the ID if queue persistence fails, then retries successfully with that ID', async () => {
    vi.mocked(post).mockRejectedValue(new TypeError('offline'));
    vi.mocked(db.queue.put).mockRejectedValueOnce(new Error('storage full'));
    const attempt = new CreationAttempt();
    const ids: string[] = [];
    const submit = (id: string) => {
      ids.push(id);
      return createTrackedApplication('student-one', id, draft).then(() => true);
    };
    await expect(attempt.run(submit)).rejects.toThrow('storage full');
    expect(await attempt.run(submit)).toBe(true);
    expect(ids[1]).toBe(ids[0]);
  });

  it('allows intentional separate applications with identical company and title', async () => {
    vi.mocked(post).mockResolvedValue({});
    const attempt = new CreationAttempt();
    const submit = (id: string) => createTrackedApplication('student-one', id, draft).then(() => true);
    await attempt.run(submit);
    await attempt.run(submit);
    expect(post).toHaveBeenCalledTimes(2);
    expect(vi.mocked(post).mock.calls[0][1]).not.toEqual(vi.mocked(post).mock.calls[1][1]);
    expect(db.queue.put).not.toHaveBeenCalled();
  });
});
