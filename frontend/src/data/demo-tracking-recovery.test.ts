import { describe, expect, it } from 'vitest';
import { createDemoTransport, type DemoTransportHandle } from './demo-transport';
import { DEMO_USER_IDS } from './demo-seed';
import type { Schema } from './demo-types';

const NOW = new Date('2026-09-29T02:00:00.000Z');
const CREATION_ID = '91000000-0000-4000-8000-000000000001';

async function call<T = unknown>(transport: DemoTransportHandle, method: string, path: string, body?: unknown) {
  const response = await transport(`/api/v1${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  });
  const text = await response.text();
  return { status: response.status, payload: (text ? JSON.parse(text) : undefined) as T };
}

async function ok<T = unknown>(transport: DemoTransportHandle, method: string, path: string, body?: unknown): Promise<T> {
  const response = await call<T>(transport, method, path, body);
  expect(response.status, JSON.stringify(response.payload)).toBeLessThan(400);
  return response.payload;
}

async function setup(now: () => Date = () => new Date(NOW)) {
  const transport = createDemoTransport({ persist: false, latencyMs: 0, latencyJitterMs: 0, now });
  await ok(transport, 'POST', '/session', { userId: DEMO_USER_IDS.student2 });
  return transport;
}

function creationOperation() {
  return {
    opId: CREATION_ID, entity: 'application', entityId: CREATION_ID, action: 'upsert', baseVersion: 0,
    payload: { creationId: CREATION_ID, jobTitle: '重试投递', company: '示例公司', status: 'preparing' },
  };
}

describe('演示数据源 · 投递归档恢复与创建重试', () => {
  it('失败的离线创建回执重放保持失败，修正内容后复用同一标识不能返回假成功', async () => {
    const transport = await setup();
    const operation = creationOperation();
    const rejected = await ok<Schema['SyncResponse']>(transport, 'POST', '/sync/operations', {
      operations: [{ ...operation, payload: { company: '缺少岗位标题' } }],
    });
    expect(rejected.results[0]).toMatchObject({ status: 'rejected', details: [{ field: 'jobTitle' }] });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const retry = await call<Schema['ErrorBody']>(transport, 'POST', '/applications', operation.payload);
      expect(retry.status).toBe(422);
      expect(retry.payload.error).toMatchObject({ code: 'invalid_request', details: [{ field: 'jobTitle' }] });
    }
    const replay = await ok<Schema['SyncResponse']>(transport, 'POST', '/sync/operations', { operations: [operation] });
    expect(replay.results[0]).toEqual(rejected.results[0]);
    expect((await ok<{ items: Schema['Application'][] }>(transport, 'GET', '/applications')).items).toHaveLength(0);
    expect((await call(transport, 'GET', `/applications/${CREATION_ID}`)).status).toBe(404);
  });

  it('在线重试与离线重放共用创建标识，归档后的重放不恢复卡片', async () => {
    const transport = await setup();
    const operation = creationOperation();
    const [first, retry] = await Promise.all([
      call<Schema['Application']>(transport, 'POST', '/applications', operation.payload),
      call<Schema['Application']>(transport, 'POST', '/applications', operation.payload),
    ]);
    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(first.payload.id).toBe(CREATION_ID);
    expect(retry.payload).toEqual(first.payload);
    const replay = await ok<Schema['SyncResponse']>(transport, 'POST', '/sync/operations', { operations: [operation] });
    expect(replay.results[0]).toMatchObject({ status: 'duplicate', version: 1, record: { id: CREATION_ID } });
    expect((await ok<{ items: Schema['Application'][] }>(transport, 'GET', '/applications')).items).toHaveLength(1);
    expect((await ok<{ items: Schema['ApplicationEvent'][] }>(transport, 'GET', `/applications/${CREATION_ID}/events`)).items).toHaveLength(1);

    await ok(transport, 'DELETE', `/applications/${CREATION_ID}`);
    expect(await ok(transport, 'POST', '/applications', operation.payload)).toMatchObject({ id: CREATION_ID, deleted: true, version: 2 });
    expect(await ok(transport, 'GET', `/applications/${CREATION_ID}`)).toMatchObject({ id: CREATION_ID, deleted: true, version: 2 });
    const archivedReplay = await ok<Schema['SyncResponse']>(transport, 'POST', '/sync/operations', { operations: [operation] });
    expect(archivedReplay.results[0]).toMatchObject({ status: 'duplicate', version: 2, record: { deleted: true } });
    expect(await ok(transport, 'GET', `/applications/${CREATION_ID}`)).toMatchObject({ deleted: true, version: 2 });
    expect((await ok<{ items: Schema['Application'][] }>(transport, 'GET', '/applications')).items).toHaveLength(0);
    expect((await ok<{ items: Schema['ApplicationEvent'][] }>(transport, 'GET', `/applications/${CREATION_ID}/events`)).items).toHaveLength(1);
    expect((await call(transport, 'POST', '/applications', { ...operation.payload, creationId: 'invalid' })).status).toBe(422);
    const mismatched = await ok<Schema['SyncResponse']>(transport, 'POST', '/sync/operations', { operations: [{ ...operation, action: 'delete' }] });
    expect(mismatched.results[0]).toMatchObject({ status: 'rejected', error: '操作 ID 已被其他请求使用' });
  });

  it('归档保留子记录但排除关联统计，恢复版本检查不会阻止安全重试', async () => {
    const transport = await setup();
    const application = await ok<Schema['Application']>(transport, 'POST', '/applications', { jobTitle: '可恢复投递', status: 'interviewing' });
    const interview = await ok<Schema['Interview']>(transport, 'POST', `/applications/${application.id}/interviews`, { scheduledAt: '2026-09-30T03:00:00.000Z' });
    await ok(transport, 'POST', '/time-entries', { applicationId: application.id, minutes: 120, spentOn: '2026-09-29' });
    await ok(transport, 'POST', '/time-entries', { minutes: 60, spentOn: '2026-09-29' });
    const statsPath = '/applications/stats?from=2026-09-01&to=2026-09-30';
    expect(await ok(transport, 'GET', statsPath)).toMatchObject({ interviewedCount: 1, totalHours: 3 });
    await ok(transport, 'DELETE', `/applications/${application.id}`);
    await ok(transport, 'DELETE', `/applications/${application.id}`);
    const archived = await ok<Schema['Application']>(transport, 'GET', `/applications/${application.id}`);
    expect(archived).toMatchObject({ deleted: true, version: 2 });
    expect((await ok<{ items: Schema['Application'][] }>(transport, 'GET', '/applications?archived=true')).items).toEqual([archived]);
    expect((await ok<{ items: Schema['ApplicationEvent'][] }>(transport, 'GET', `/applications/${application.id}/events`)).items).toHaveLength(1);
    expect((await ok<{ items: Schema['Interview'][] }>(transport, 'GET', `/applications/${application.id}/interviews`)).items).toEqual([interview]);
    expect((await ok<{ items: Schema['TimeEntry'][] }>(transport, 'GET', '/time-entries?from=2026-09-01&to=2026-09-30')).items).toHaveLength(2);
    expect(await ok(transport, 'GET', statsPath)).toMatchObject({ interviewedCount: 0, totalHours: 1 });

    const blockedRequests: [string, string, unknown][] = [
      ['PATCH', `/applications/${application.id}`, { notes: '不允许修改', baseVersion: 2 }],
      ['POST', `/applications/${application.id}/events`, { type: 'note', note: '不允许修改' }],
      ['POST', `/applications/${application.id}/interviews`, { scheduledAt: '2026-09-30T04:00:00.000Z' }],
      ['PATCH', `/interviews/${interview.id}`, { feedback: '不允许修改', baseVersion: 1 }],
    ];
    for (const [method, path, body] of blockedRequests) expect((await call(transport, method, path, body)).status).toBe(404);
    expect((await call(transport, 'POST', `/applications/${application.id}/restore`, { baseVersion: 1 })).status).toBe(409);
    expect((await call(transport, 'POST', `/applications/${application.id}/restore`, {})).status).toBe(422);
    const restored = await ok<Schema['Application']>(transport, 'POST', `/applications/${application.id}/restore`, { baseVersion: 2 });
    expect(restored).toMatchObject({ deleted: false, version: 3, status: 'interviewing' });
    expect(await ok(transport, 'POST', `/applications/${application.id}/restore`, { baseVersion: 2 })).toEqual(restored);
    expect(await ok(transport, 'GET', statsPath)).toMatchObject({ interviewedCount: 1, totalHours: 3 });
    const changes = await ok<Schema['SyncChangesResponse']>(transport, 'GET', '/sync/changes?since=0');
    expect(changes.changes.filter((change) => change.entityId === application.id).map((change) => change.changeType)).toEqual(['upsert', 'delete', 'upsert']);
    await ok(transport, 'POST', '/session', { userId: DEMO_USER_IDS.student });
    expect((await call(transport, 'POST', `/applications/${application.id}/restore`, { baseVersion: 3 })).status).toBe(404);
  });

  it('归档抑制提醒，恢复不补发已过提醒时间的面试，保留已发送历史', async () => {
    let now = new Date(NOW);
    const transport = await setup(() => new Date(now));
    const application = await ok<Schema['Application']>(transport, 'POST', '/applications', { jobTitle: '面试提醒测试' });
    const addInterview = (scheduledAt: string) => ok<Schema['Interview']>(transport, 'POST', `/applications/${application.id}/interviews`, { scheduledAt });
    const sent = await addInterview('2026-09-29T02:30:00.000Z');
    const elapsed = await addInterview('2026-09-29T06:00:00.000Z');
    const imminent = await addInterview('2026-09-29T08:30:00.000Z');
    const future = await addInterview('2026-09-30T03:00:00.000Z');
    const notifications = () => ok<{ items: Schema['Notification'][] }>(transport, 'GET', '/notifications');
    expect((await notifications()).items.map((row) => row.entityId)).toEqual([sent.id]);
    await ok(transport, 'DELETE', `/applications/${application.id}`);
    now = new Date('2026-09-29T08:00:00.000Z');
    expect((await notifications()).items.map((row) => row.entityId)).toEqual([sent.id]);
    await ok(transport, 'POST', `/applications/${application.id}/restore`, { baseVersion: 2 });
    expect((await notifications()).items.map((row) => row.entityId)).toEqual([sent.id]);
    now = new Date('2026-09-30T02:00:00.000Z');
    const ids = (await notifications()).items.map((row) => row.entityId);
    expect(ids).toContain(future.id);
    expect(ids).toContain(sent.id);
    expect(ids).not.toContain(elapsed.id);
    expect(ids).not.toContain(imminent.id);
  });

  it('离线优先创建也只创建一次，离线修改不能越过归档限制', async () => {
    const transport = await setup();
    const operation = creationOperation();
    const created = await ok<Schema['SyncResponse']>(transport, 'POST', '/sync/operations', { operations: [operation] });
    expect(created.results[0]).toMatchObject({ status: 'applied', record: { id: CREATION_ID } });
    expect((await ok<Schema['Application']>(transport, 'POST', '/applications', operation.payload)).id).toBe(CREATION_ID);
    const edited = await ok<Schema['SyncResponse']>(transport, 'POST', '/sync/operations', {
      operations: [{ ...operation, opId: 'edit-active-notes', baseVersion: 1, payload: { notes: '离线补充备注' } }],
    });
    expect(edited.results[0]).toMatchObject({ status: 'applied', version: 2, record: { notes: '离线补充备注' } });
    const interview = await ok<Schema['Interview']>(transport, 'POST', `/applications/${CREATION_ID}/interviews`, { scheduledAt: '2026-09-30T03:00:00.000Z' });
    const archived = await ok<Schema['SyncResponse']>(transport, 'POST', '/sync/operations', {
      operations: [{ opId: 'archive-application', entity: 'application', entityId: CREATION_ID, action: 'delete', baseVersion: 2 }],
    });
    expect(archived.results[0]).toMatchObject({ status: 'applied', version: 3, record: { deleted: true } });
    const edits = await ok<Schema['SyncResponse']>(transport, 'POST', '/sync/operations', {
      operations: [
        { ...operation, opId: 'edit-archived', baseVersion: 2 },
        { opId: 'edit-archived-interview', entity: 'interview', entityId: interview.id, action: 'upsert', baseVersion: 1, payload: { applicationId: CREATION_ID, scheduledAt: '2026-10-01T03:00:00.000Z' } },
        { opId: 'note-archived', entity: 'application_event', entityId: '93000000-0000-4000-8000-000000000001', action: 'upsert', baseVersion: 0, payload: { applicationId: CREATION_ID, type: 'note' } },
      ],
    });
    expect(edits.results.map((result) => result.status)).toEqual(['conflict', 'rejected', 'rejected']);
    expect((await ok<{ items: Schema['ApplicationEvent'][] }>(transport, 'GET', `/applications/${CREATION_ID}/events`)).items).toHaveLength(1);
  });
});
