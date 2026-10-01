import { describe, expect, it } from "vitest";
import { getMf, loginAs, requestAs, STUDENT, STUDENT2 } from "./helpers";
import { cronTick } from "../src/application/reminders";
import type { Env } from "../src/env";

const json = (body: unknown, method = "POST") => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const payload = { jobTitle: "同一岗位", company: "同一公司", notes: "保留备注", status: "preparing" };
type Application = { id: string; version: number; deleted: boolean; notes: string; status: string };

async function create(cookie: string, creationId = crypto.randomUUID()) {
  const response = await requestAs(cookie, "/applications", json({ ...payload, creationId }));
  expect(response.status).toBe(201);
  return response.json<Application>();
}

async function syncCreate(cookie: string, id: string) {
  const response = await requestAs(cookie, "/sync/operations", json({ operations: [
    { opId: id, entity: "application", entityId: id, baseVersion: 0, action: "upsert", payload },
  ] }));
  return (await response.json<{ results: { status: string; record: Application }[] }>()).results[0]!;
}

describe("投递创建幂等与可恢复归档", () => {
  it("并发双击及在线提交后的离线重放只有一张卡、一条初始历史和一份回执", async () => {
    const cookie = await loginAs(STUDENT);
    const id = crypto.randomUUID();
    const [first, second] = await Promise.all([create(cookie, id), create(cookie, id)]);
    expect(first).toEqual(second);
    expect(first.id).toBe(id);
    expect((await syncCreate(cookie, id)).status).toBe("duplicate");
    const { mf } = await getMf();
    const db = await mf.getD1Database("DB");
    expect(await db.prepare("SELECT COUNT(*) AS n FROM applications WHERE id=?1").bind(id).first()).toEqual({ n: 1 });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM application_events WHERE application_id=?1").bind(id).first()).toEqual({ n: 1 });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM sync_operations WHERE user_id=?1 AND op_id=?2").bind(STUDENT, id).first()).toEqual({ n: 1 });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM change_log WHERE entity='application' AND entity_id=?1").bind(id).first()).toEqual({ n: 1 });
    // Intentional distinct applications with identical titles/companies remain valid.
    const distinct = await create(cookie);
    expect(distinct.id).not.toBe(id);
    expect((await (await requestAs(cookie, "/applications")).json<{ items: Application[] }>()).items).toHaveLength(2);
  });

  it("离线先到、在线后重试共用回执；跨用户创建 ID 碰撞不会暴露记录", async () => {
    const cookie = await loginAs(STUDENT);
    const id = crypto.randomUUID();
    const offline = await syncCreate(cookie, id);
    expect(offline.status).toBe("applied");
    expect(await create(cookie, id)).toEqual(offline.record);
    const other = await loginAs(STUDENT2);
    const collision = await requestAs(other, "/applications", json({ ...payload, creationId: id }));
    expect(collision.status).not.toBe(201);
    expect(await collision.text()).not.toContain("保留备注");
    expect((await (await requestAs(other, "/applications?archived=true")).json<{ items: unknown[] }>()).items).toEqual([]);
    expect((await requestAs(other, `/applications/${id}/restore`, json({ baseVersion: 1 }))).status).toBe(404);
  });

  it("初始历史写入失败时整次创建回滚，同一 ID 可安全重试", async () => {
    const cookie = await loginAs(STUDENT);
    const id = crypto.randomUUID();
    const { mf } = await getMf();
    const db = await mf.getD1Database("DB");
    await db.prepare("CREATE TRIGGER fail_initial_event BEFORE INSERT ON application_events BEGIN SELECT RAISE(ABORT, 'event failed'); END").run();
    expect((await requestAs(cookie, "/applications", json({ ...payload, creationId: id }))).status).toBe(500);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM applications WHERE id=?1").bind(id).first()).toEqual({ n: 0 });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM sync_operations WHERE op_id=?1").bind(id).first()).toEqual({ n: 0 });
    await db.prepare("DROP TRIGGER fail_initial_event").run();
    expect((await create(cookie, id)).id).toBe(id);
  });

  it("失败的离线创建回执重放仍是失败，不会伪造 201 成功", async () => {
    const cookie = await loginAs(STUDENT);
    const id = crypto.randomUUID();
    const rejected = await requestAs(cookie, "/sync/operations", json({ operations: [{
      opId: id, entity: "application", entityId: id, baseVersion: 0, action: "upsert", payload: {},
    }] }));
    expect((await rejected.json<{ results: { status: string }[] }>()).results[0]?.status).toBe("rejected");
    for (let retry = 0; retry < 2; retry++) {
      expect((await requestAs(cookie, "/applications", json({ ...payload, creationId: id }))).status).toBe(422);
    }
    expect((await (await requestAs(cookie, "/applications")).json<{ items: unknown[] }>()).items).toEqual([]);
  });

  it("归档保留关联记录，排除活动统计并阻止修改；正常恢复保留 ID 与历史", async () => {
    const cookie = await loginAs(STUDENT);
    const application = await create(cookie);
    for (const status of ["submitted", "interviewing"]) {
      expect((await requestAs(cookie, `/applications/${application.id}/events`, json({ type: "status_change", toStatus: status }))).status).toBe(201);
    }
    const interviewResponse = await requestAs(cookie, `/applications/${application.id}/interviews`, json({ scheduledAt: new Date(Date.now() + 3 * 3600_000).toISOString(), stage: "初试" }));
    const interview = await interviewResponse.json<{ id: string; version: number }>();
    const day = new Date().toISOString().slice(0, 10);
    for (const applicationId of [application.id, null]) {
      expect((await requestAs(cookie, "/time-entries", json({ applicationId, minutes: 60, spentOn: day }))).status).toBe(201);
    }
    const statsPath = `/applications/stats?from=${day}&to=${day}`;
    expect(await (await requestAs(cookie, statsPath)).json()).toMatchObject({ interviewedCount: 1, totalHours: 2 });
    expect((await requestAs(cookie, `/applications/${application.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await requestAs(cookie, `/applications/${application.id}`, { method: "DELETE" })).status).toBe(204);
    const archived = await (await requestAs(cookie, `/applications/${application.id}`)).json<Application>();
    expect(archived).toMatchObject({ deleted: true, notes: payload.notes, status: "interviewing", version: 4 });
    expect((await (await requestAs(cookie, "/applications")).json<{ items: unknown[] }>()).items).toEqual([]);
    expect((await (await requestAs(cookie, "/applications?archived=true")).json<{ items: Application[] }>()).items[0]).toEqual(archived);
    expect((await (await requestAs(cookie, `/applications/${application.id}/events`)).json<{ items: unknown[] }>()).items).toHaveLength(3);
    expect((await (await requestAs(cookie, `/applications/${application.id}/interviews`)).json<{ items: { id: string }[] }>()).items[0]?.id).toBe(interview.id);
    expect((await (await requestAs(cookie, `/time-entries?from=${day}&to=${day}`)).json<{ items: unknown[] }>()).items).toHaveLength(2);
    expect(await (await requestAs(cookie, statsPath)).json()).toMatchObject({ interviewedCount: 0, totalHours: 1 });
    expect((await requestAs(cookie, `/interviews/${interview.id}`, json({ result: "passed", baseVersion: interview.version }, "PATCH"))).status).toBe(404);
    expect((await requestAs(cookie, `/applications/${application.id}/events`, json({ type: "feedback", note: "blocked" }))).status).toBe(404);
    const history = await (await requestAs(cookie, `/applications/${application.id}/events`)).json<{ items: { id: string; version: number }[] }>();
    const deletingChildren = await requestAs(cookie, "/sync/operations", json({ operations: [
      { opId: crypto.randomUUID(), entity: "interview", entityId: interview.id, baseVersion: interview.version, action: "delete" },
      { opId: crypto.randomUUID(), entity: "application_event", entityId: history.items[0]!.id, baseVersion: history.items[0]!.version, action: "delete" },
    ] }));
    expect((await deletingChildren.json<{ results: { status: string }[] }>()).results.map((item) => item.status)).toEqual(["rejected", "rejected"]);
    expect(await create(cookie, application.id)).toMatchObject({ deleted: true, version: archived.version });
    const staleOffline = await requestAs(cookie, "/sync/operations", json({ operations: [{
      opId: crypto.randomUUID(), entity: "application", entityId: application.id, baseVersion: 3,
      action: "upsert", payload: { notes: "旧设备的离线修改" },
    }] }));
    expect((await staleOffline.json<{ results: { status: string; record: Application }[] }>()).results[0]).toMatchObject({ status: "conflict", record: { deleted: true, notes: payload.notes } });
    expect((await requestAs(cookie, `/applications/${application.id}/restore`, json({ baseVersion: 1 }))).status).toBe(409);
    const restored = await (await requestAs(cookie, `/applications/${application.id}/restore`, json({ baseVersion: archived.version }))).json<Application>();
    expect(restored).toMatchObject({ id: application.id, version: 5, deleted: false, notes: payload.notes, status: "interviewing" });
    expect(await (await requestAs(cookie, `/applications/${application.id}/restore`, json({ baseVersion: archived.version }))).json()).toEqual(restored);
    expect(await (await requestAs(cookie, statsPath)).json()).toMatchObject({ interviewedCount: 1, totalHours: 2 });
    // Retrying the original create does not undo archive/restore or add history.
    await create(cookie, application.id);
    expect((await (await requestAs(cookie, `/applications/${application.id}`)).json<Application>()).version).toBe(5);
    expect((await (await requestAs(cookie, `/applications/${application.id}/events`)).json<{ items: unknown[] }>()).items).toHaveLength(3);
    const changes = await (await requestAs(cookie, "/sync/changes?since=0")).json<{ changes: { entityId: string; changeType: string; record: { deleted: boolean } }[] }>();
    expect(changes.changes.filter((row) => row.entityId === application.id).at(-1)).toMatchObject({ changeType: "upsert", record: { deleted: false } });
  });

  it("归档暂停面试提醒，恢复只启用未来提醒，不补发归档期间过期提醒", async () => {
    const cookie = await loginAs(STUDENT);
    const application = await create(cookie);
    const { mf } = await getMf();
    const DB = await mf.getD1Database("DB");
    const reminderIds: string[] = [];
    for (const delta of [-2, 4]) {
      const interview = await (await requestAs(cookie, `/applications/${application.id}/interviews`, json({ scheduledAt: new Date(Date.now() + delta * 3600_000).toISOString(), stage: "面试" }))).json<{ id: string }>();
      reminderIds.push(interview.id);
    }
    await requestAs(cookie, `/applications/${application.id}`, { method: "DELETE" });
    const env = { DB } as unknown as Env;
    expect(await cronTick(env)).toMatchObject({ due: 0, sentInApp: 0, sentPush: 0 });
    expect(await DB.prepare("SELECT COUNT(*) AS n FROM reminders WHERE user_id=?1 AND status='pending'").bind(STUDENT).first()).toEqual({ n: 2 });
    await requestAs(cookie, `/applications/${application.id}/restore`, json({ baseVersion: 2 }));
    expect(await DB.prepare("SELECT status FROM reminders WHERE entity_id=?1").bind(reminderIds[0]).first()).toEqual({ status: "cancelled" });
    expect(await DB.prepare("SELECT status FROM reminders WHERE entity_id=?1").bind(reminderIds[1]).first()).toEqual({ status: "pending" });
    expect(await cronTick(env)).toMatchObject({ due: 0, sentInApp: 0 });
    expect(await cronTick(env, new Date(Date.now() + 4 * 3600_000).toISOString())).toMatchObject({ due: 1, sentInApp: 1 });
  });

  it("恢复日志失败时保持归档和待发提醒不变，可安全重试", async () => {
    const cookie = await loginAs(STUDENT);
    const application = await create(cookie);
    await requestAs(cookie, `/applications/${application.id}/interviews`, json({ scheduledAt: new Date(Date.now() - 3600_000).toISOString() }));
    await requestAs(cookie, `/applications/${application.id}`, { method: "DELETE" });
    const { mf } = await getMf();
    const db = await mf.getD1Database("DB");
    await db.prepare("CREATE TRIGGER fail_restore_log BEFORE INSERT ON change_log WHEN NEW.entity = 'application' AND NEW.version = 3 BEGIN SELECT RAISE(ABORT, 'restore log failed'); END").run();
    expect((await requestAs(cookie, `/applications/${application.id}/restore`, json({ baseVersion: 2 }))).status).toBe(500);
    expect(await db.prepare("SELECT deleted, version FROM applications WHERE id=?1").bind(application.id).first()).toEqual({ deleted: 1, version: 2 });
    expect(await db.prepare("SELECT status FROM reminders WHERE user_id=?1").bind(STUDENT).first()).toEqual({ status: "pending" });
    await db.prepare("DROP TRIGGER fail_restore_log").run();
    expect((await requestAs(cookie, `/applications/${application.id}/restore`, json({ baseVersion: 2 }))).status).toBe(200);
    expect(await db.prepare("SELECT status FROM reminders WHERE user_id=?1").bind(STUDENT).first()).toEqual({ status: "cancelled" });
  });

  it.each(["due", "subscriptions"])("Cron 在 %s 读取后发生归档/恢复，不推送已过期提醒", async (boundary) => {
    const cookie = await loginAs(STUDENT);
    const application = await create(cookie);
    await requestAs(cookie, `/applications/${application.id}/interviews`, json({ scheduledAt: new Date(Date.now() - 3600_000).toISOString() }));
    const { mf } = await getMf();
    const DB = await mf.getD1Database("DB");
    const now = new Date().toISOString();
    await DB.prepare(`INSERT INTO push_subscriptions (id,user_id,endpoint,p256dh,auth,status,created_at,updated_at)
      VALUES (?1,?2,'https://push.example.test/test','fixture-key','fixture-auth','active',?3,?3)`)
      .bind(crypto.randomUUID(), STUDENT, now).run();
    let intercepted = false;
    const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => new Proxy(statement, {
      get(target, key) {
        if (key === "bind") return (...params: unknown[]) => wrap(target.bind(...params), sql);
        if (key === "all" && (boundary === "due" ? sql.startsWith("SELECT * FROM reminders WHERE (status") : sql.includes("SELECT * FROM push_subscriptions"))) {
          return async () => {
            const result = await target.all();
            if (!intercepted) {
              intercepted = true;
              await requestAs(cookie, `/applications/${application.id}`, { method: "DELETE" });
              await requestAs(cookie, `/applications/${application.id}/restore`, json({ baseVersion: 2 }));
            }
            return result;
          };
        }
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const interceptedDb = new Proxy(DB, {
      get(target, key) {
        if (key === "prepare") return (sql: string) => wrap(target.prepare(sql) as unknown as D1PreparedStatement, sql);
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    let pushes = 0;
    await cronTick({ DB: interceptedDb } as unknown as Env, now, async () => { pushes++; return { ok: true, statusCode: 201 }; });
    expect(intercepted).toBe(true);
    expect(pushes).toBe(0);
    const reminder = await DB.prepare("SELECT status,retry_count FROM reminders WHERE user_id=?1").bind(STUDENT).first();
    expect(reminder).toEqual({ status: boundary === "due" ? "cancelled" : "sent", retry_count: -1 });
  });
});
