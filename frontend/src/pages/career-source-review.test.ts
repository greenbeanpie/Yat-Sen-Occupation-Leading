import { describe, expect, it, vi } from 'vitest';
import {
  createCareerReviewController, type CareerDraft, type CareerListing, type CareerPreview,
  type CareerReviewApi, type CareerStatus,
} from './career-source-review';

const hash = 'a'.repeat(64);
const listing: CareerListing = { schemaVersion: 1, retrievedAt: '2026-10-01T12:00:00Z', expiresAt: '2026-10-01T12:15:00Z',
  items: [{ id: '997448', title: '公开招聘公告', url: 'https://career.sysu.edu.cn/campus/view/id/997448', publishedAt: '2026-09-30 21:45:47', pinned: false }] };
const status: CareerStatus = { schemaVersion: 1, sourceId: 'sysu-campus', cachedList: listing, extractionAvailable: true,
  extractionUnavailableReason: null, cacheTtlSeconds: 900, publicationSupported: false };
const preview: CareerPreview = { schemaVersion: 1, title: '公开招聘公告', employer: null, warnings: [], expiresAt: listing.expiresAt,
  source: { text: '公开公告正文', versionHash: hash, metadata: { url: listing.items[0].url, numericId: '997448', retrievedAt: listing.retrievedAt,
    originalDate: null, sourceExpiry: null, captureMethod: 'static-html-text', partial: true } } };
const draft: CareerDraft = { status: 'needs-human-review', provider: 'fixture-only', source: preview.source, warnings: ['需人工审核'],
  candidate: { schemaVersion: 1, title: null, employer: null, applicationDeadline: null, sharedRequirements: [], positions: [], ambiguities: [] } };
function setup(overrides: Partial<CareerReviewApi> = {}, now = Date.parse('2026-10-01T12:01:00Z')) {
  const api: CareerReviewApi = { status: vi.fn().mockResolvedValue(status), refresh: vi.fn().mockResolvedValue(listing),
    preview: vi.fn().mockResolvedValue(preview), extract: vi.fn().mockResolvedValue(draft), ...overrides };
  return { api, controller: createCareerReviewController(api, () => now) };
}
describe('manual career review controller, fixture-only network', () => {
  it('does nothing until requested and initial status reads cached data without source/model calls', async () => {
    const { api, controller } = setup();
    expect(api.status).not.toHaveBeenCalled(); await controller.readStatus();
    expect(api.status).toHaveBeenCalledOnce(); expect(api.refresh).not.toHaveBeenCalled();
    expect(api.preview).not.toHaveBeenCalled(); expect(api.extract).not.toHaveBeenCalled();
    expect(controller.getState().listing).toEqual(listing);
  });
  it('uses only selected numeric ID and immutable source hash; never creates or publishes a job', async () => {
    const { api, controller } = setup(); await controller.readStatus(); await controller.preview('997448'); await controller.extract();
    expect(api.preview).toHaveBeenCalledExactlyOnceWith({ id: '997448' });
    expect(api.extract).toHaveBeenCalledExactlyOnceWith({ id: '997448', sourceVersionHash: hash });
    expect(Object.keys(api)).toEqual(['status', 'refresh', 'preview', 'extract']);
    expect(controller.getState().draft).toEqual(draft);
  });
  it.each(['https://other.test', '../997448', '1', '997448?token=x'])('rejects unlisted/invalid selection %s before API', async id => {
    const { api, controller } = setup(); await controller.readStatus(); expect(await controller.preview(id)).toBe(false);
    expect(api.preview).not.toHaveBeenCalled(); expect(api.extract).not.toHaveBeenCalled();
  });
  it('blocks mock/unconfigured extraction without emitting a fake candidate', async () => {
    const { api, controller } = setup({ status: vi.fn().mockResolvedValue({ ...status, extractionAvailable: false }) });
    await controller.readStatus(); await controller.preview('997448'); expect(await controller.extract()).toBe(false);
    expect(api.extract).not.toHaveBeenCalled(); expect(controller.getState().draft).toBeNull();
    expect(controller.getState().error).toContain('不会以模拟结果替代');
  });
  it('rejects expired source before calling model and requires a new preview', async () => {
    const { api, controller } = setup({}, Date.parse(listing.expiresAt)); await controller.readStatus(); await controller.preview('997448');
    expect(await controller.extract()).toBe(false); expect(api.extract).not.toHaveBeenCalled(); expect(controller.getState().requiresPreview).toBe(true);
  });
  it('collapses rapid extraction clicks to one request and never automatically retries errors', async () => {
    let reject!: (error: Error) => void;
    const extract = vi.fn(() => new Promise<CareerDraft>((_resolve, no) => { reject = no; }));
    const { api, controller } = setup({ extract }); await controller.readStatus(); await controller.preview('997448');
    const first = controller.extract(), repeat = controller.extract(); expect(repeat).toBe(first);
    await vi.waitFor(() => expect(extract).toHaveBeenCalledOnce()); reject(new Error('模型请求失败'));
    expect(await first).toBe(false); expect(api.extract).toHaveBeenCalledOnce(); expect(controller.getState().preview).toEqual(preview);
    expect(controller.getState().draft).toBeNull(); expect(controller.getState().operation).toBeNull();
  });
  it('preserves an existing review on source HTTP failure, without pretend success or retry', async () => {
    const { api, controller } = setup({ refresh: vi.fn().mockRejectedValue(new Error('来源拒绝访问，已停止并冷却 15 分钟')) });
    await controller.readStatus(); await controller.preview('997448'); await controller.extract();
    expect(await controller.refresh()).toBe(false); expect(api.refresh).toHaveBeenCalledOnce();
    expect(controller.getState().draft).toEqual(draft); expect(controller.getState().error).toContain('冷却 15 分钟');
  });
  it('invalidates stale draft on version conflict and does not automatically refetch or recall model', async () => {
    const extract = vi.fn().mockRejectedValue(Object.assign(new Error('来源版本变化，请重新预览'), { status: 409 }));
    const { api, controller } = setup({ extract }); await controller.readStatus(); await controller.preview('997448');
    await controller.extract(); await controller.extract();
    expect(extract).toHaveBeenCalledOnce(); expect(api.preview).toHaveBeenCalledOnce(); expect(controller.getState().requiresPreview).toBe(true);
  });
  it('refuses a candidate for another source hash, then clears preview and review on a manual list refresh', async () => {
    const { controller } = setup({ extract: vi.fn().mockResolvedValue({ ...draft, source: { ...preview.source, versionHash: 'b'.repeat(64) } }) });
    await controller.readStatus(); await controller.preview('997448'); expect(await controller.extract()).toBe(false);
    expect(controller.getState().draft).toBeNull(); expect(controller.getState().requiresPreview).toBe(true);
    await controller.refresh(); expect(controller.getState()).toMatchObject({ preview: null, draft: null, selectedId: null, requiresPreview: false });
  });
});
