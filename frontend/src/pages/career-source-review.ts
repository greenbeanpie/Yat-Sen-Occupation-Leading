import type { components } from '../api/schema';

export type CareerStatus = components['schemas']['CareerSourceStatus'];
export type CareerListing = components['schemas']['CareerSourceListing'];
export type CareerPreview = components['schemas']['CareerSourcePreview'];
export type CareerDraft = components['schemas']['CareerExtractionReview'];
export type CareerOperation = 'status' | 'refresh' | 'preview' | 'extract';
export interface CareerReviewState {
  status: CareerStatus | null;
  listing: CareerListing | null;
  selectedId: string | null;
  preview: CareerPreview | null;
  draft: CareerDraft | null;
  operation: CareerOperation | null;
  error: string;
  requiresPreview: boolean;
}
export interface CareerReviewApi {
  status: () => Promise<CareerStatus>;
  refresh: () => Promise<CareerListing>;
  preview: (body: { id: string }) => Promise<CareerPreview>;
  extract: (body: { id: string; sourceVersionHash: string }) => Promise<CareerDraft>;
}

/** In-memory, explicit-click controller. No URLs, personal profile, job writes or retries. */
export function createCareerReviewController(api: CareerReviewApi, now = Date.now) {
  let state: CareerReviewState = {
    status: null, listing: null, selectedId: null, preview: null, draft: null,
    operation: null, error: '', requiresPreview: false,
  };
  let pending: Promise<boolean> | null = null;
  const listeners = new Set<() => void>();
  function update(patch: Partial<CareerReviewState>) {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  }
  function reject(message: string) { update({ error: message }); return Promise.resolve(false); }
  function perform(operation: CareerOperation, action: () => Promise<void>) {
    if (pending) return pending;
    update({ operation, error: '' });
    pending = Promise.resolve().then(action).then(() => true).catch((error: unknown) => {
      const conflict = !!error && typeof error === 'object' && 'status' in error && error.status === 409;
      update({
        error: error instanceof Error ? error.message : '操作失败，请检查后手动重试。',
        ...(conflict ? { draft: null, requiresPreview: true } : {}),
      });
      return false;
    }).finally(() => { pending = null; update({ operation: null }); });
    return pending;
  }
  return {
    getState: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    readStatus: () => perform('status', async () => {
      const status = await api.status();
      update({ status, listing: status.cachedList });
    }),
    refresh: () => perform('refresh', async () => {
      const listing = await api.refresh();
      update({ listing, selectedId: null, preview: null, draft: null, requiresPreview: false });
    }),
    preview(id: string) {
      if (pending) return pending;
      if (!/^\d{1,12}$/.test(id) || !state.listing?.items.some(item => item.id === id)) {
        return reject('请从当前公告列表选择一条来源。');
      }
      update({ selectedId: id, preview: null, draft: null, requiresPreview: false });
      return perform('preview', async () => {
        const preview = await api.preview({ id });
        if (preview.source.metadata.numericId !== id) throw new Error('来源编号不一致，请重新预览。');
        update({ preview });
      });
    },
    extract() {
      if (pending) return pending;
      const preview = state.preview;
      if (!state.status?.extractionAvailable) return reject('尚未配置真实模型；不会以模拟结果替代公告提取。');
      if (!preview || state.requiresPreview || !(Date.parse(preview.expiresAt) > now())) {
        update({ draft: null, requiresPreview: true });
        return reject('来源缓存已过期或版本变化，请先重新预览。');
      }
      const body = { id: preview.source.metadata.numericId, sourceVersionHash: preview.source.versionHash };
      return perform('extract', async () => {
        const draft = await api.extract(body);
        if (draft.source.versionHash !== body.sourceVersionHash || draft.source.metadata.numericId !== body.id) {
          update({ draft: null, requiresPreview: true });
          throw new Error('候选与当前来源版本不一致，请重新预览。');
        }
        update({ draft });
      });
    },
  };
}
