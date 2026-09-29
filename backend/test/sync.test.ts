import { describe, expect, it } from "vitest";
import { getMf, loginAs, requestAs, STUDENT, STUDENT2 } from "./helpers";

describe("离线同步协议", () => {
  it("离线新建（客户端 UUID + baseVersion 0）→ applied；重复提交同 opId → duplicate", async () => {
    const cookie = await loginAs(STUDENT);
    const offlineId = crypto.randomUUID();
    const op = {
      opId: "op-create-1",
      entity: "experience",
      entityId: offlineId,
      baseVersion: 0,
      action: "upsert",
      payload: { title: "离线新增经历", description: "断网期间录入的内容。" },
    };
    const res1 = await requestAs(cookie, "/sync/operations", {
      method: "POST",
      body: JSON.stringify({ operations: [op] }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res1.status).toBe(200);
    const body1 = await res1.json<{ results: { opId: string; status: string; version: number }[] }>();
    expect(body1.results[0]?.status).toBe("applied");
    expect(body1.results[0]?.version).toBe(1);

    // 重复提交（网络重试场景）→ duplicate
    const res2 = await requestAs(cookie, "/sync/operations", {
      method: "POST",
      body: JSON.stringify({ operations: [op] }),
      headers: { "Content-Type": "application/json" },
    });
    const body2 = await res2.json<{ results: { status: string }[] }>();
    expect(body2.results[0]?.status).toBe("duplicate");

    // 数据只存在一份
    const bundle = await requestAs(cookie, "/evidence");
    const bundleBody = await bundle.json<{ experiences: { id: string }[] }>();
    expect(bundleBody.experiences.filter((e) => e.id === offlineId).length).toBe(1);
  });

  it("同步 JSON 字段映射到数据库的 *_json 列并返回规范字段", async () => {
    const cookie = await loginAs(STUDENT);
    const portfolioId = crypto.randomUUID();
    const jobId = crypto.randomUUID();
    const initial = { timeBudgetHours: 8, items: [{ jobId, pinned: false, score: 70, selected: true }], notes: { source: "offline" } };
    const created = await requestAs(cookie, "/sync/operations", {
      method: "POST",
      body: JSON.stringify({ operations: [{ opId: "portfolio-create", entity: "portfolio", entityId: portfolioId, baseVersion: 0, action: "upsert", payload: initial }] }),
      headers: { "Content-Type": "application/json" },
    });
    const createdResult = (await created.json<{ results: { status: string; record?: { items: unknown[]; notes: unknown } }[] }>()).results[0]!;
    expect(createdResult.status).toBe("applied");
    expect(createdResult.record).toMatchObject({ items: initial.items, notes: initial.notes });

    const updated = await requestAs(cookie, "/sync/operations", {
      method: "POST",
      body: JSON.stringify({ operations: [{ opId: "portfolio-update", entity: "portfolio", entityId: portfolioId, baseVersion: 1, action: "upsert", payload: { ...initial, timeBudgetHours: 10 } }] }),
      headers: { "Content-Type": "application/json" },
    });
    const updatedResult = (await updated.json<{ results: { status: string; version: number; record?: { items: unknown[]; notes: unknown; timeBudgetHours: number } }[] }>()).results[0]!;
    expect(updatedResult).toMatchObject({ status: "applied", version: 2, record: { items: initial.items, notes: initial.notes, timeBudgetHours: 10 } });
  });

  it("版本冲突：旧 baseVersion → conflict + 服务器记录；正确版本 → applied", async () => {
    const cookie = await loginAs(STUDENT);
    const create = await requestAs(cookie, "/evidence/experiences", {
      method: "POST",
      body: JSON.stringify({ title: "在线经历", description: "原始内容。" }),
      headers: { "Content-Type": "application/json" },
    });
    const exp = await create.json<{ id: string; version: number }>();

    // 用过期版本离线更新 → conflict 附服务器当前记录
    const stale = await requestAs(cookie, "/sync/operations", {
      method: "POST",
      body: JSON.stringify({
        operations: [{ opId: "op-stale", entity: "experience", entityId: exp.id, baseVersion: exp.version - 1, action: "upsert", payload: { title: "离线修改", description: "原始内容。" } }],
      }),
      headers: { "Content-Type": "application/json" },
    });
    const staleBody = await stale.json<{ results: { status: string; version?: number; record?: { title?: string } }[] }>();
    expect(staleBody.results[0]?.status).toBe("conflict");
    expect(staleBody.results[0]?.record?.title).toBe("在线经历");

    // 用户选择本地版本后，用服务器当前版本重新提交 → applied（重新提交仍检查版本）
    const fresh = await requestAs(cookie, "/sync/operations", {
      method: "POST",
      body: JSON.stringify({
        operations: [{ opId: "op-fresh", entity: "experience", entityId: exp.id, baseVersion: exp.version, action: "upsert", payload: { title: "离线修改", description: "原始内容。" } }],
      }),
      headers: { "Content-Type": "application/json" },
    });
    const freshBody = await fresh.json<{ results: { status: string; version: number }[] }>();
    expect(freshBody.results[0]?.status).toBe("applied");
    expect(freshBody.results[0]?.version).toBe(exp.version + 1);
  });

  it("双客户端交错编辑：B 拉取增量可见 A 的修改；A 的过期提交进入冲突", async () => {
    const c1 = await loginAs(STUDENT);
    const c2 = await loginAs(STUDENT2);

    // 客户端 A（学生本人）创建
    const create = await requestAs(c1, "/evidence/experiences", {
      method: "POST",
      body: JSON.stringify({ title: "共享经历", description: "初始版本。" }),
      headers: { "Content-Type": "application/json" },
    });
    const exp = await create.json<{ id: string; version: number }>();

    // 另一会话拉取增量（同用户 demo 身份乙模拟第二设备：使用同一学生账号）
    const changes1 = await requestAs(c1, "/sync/changes?since=0");
    const changesBody = await changes1.json<{ cursor: number; hasMore: boolean; changes: { entity: string; entityId: string; record: { title?: string } }[] }>();
    expect(changesBody.changes.some((ch) => ch.entityId === exp.id && ch.record.title === "共享经历")).toBe(true);

    // 设备1 在版本 1 上修改 → applied
    const edit1 = await requestAs(c1, "/sync/operations", {
      method: "POST",
      body: JSON.stringify({
        operations: [{ opId: "dev1-edit", entity: "experience", entityId: exp.id, baseVersion: exp.version, action: "upsert", payload: { title: "设备1修改", description: "初始版本。" } }],
      }),
      headers: { "Content-Type": "application/json" },
    });
    expect((await edit1.json<{ results: { status: string }[] }>()).results[0]?.status).toBe("applied");

    // 设备2（仍基于版本1）离线修改后提交 → conflict
    const edit2 = await requestAs(c1, "/sync/operations", {
      method: "POST",
      body: JSON.stringify({
        operations: [{ opId: "dev2-edit", entity: "experience", entityId: exp.id, baseVersion: exp.version, action: "upsert", payload: { title: "设备2修改", description: "初始版本。" } }],
      }),
      headers: { "Content-Type": "application/json" },
    });
    const edit2Body = await edit2.json<{ results: { status: string; record?: { title: string } }[] }>();
    expect(edit2Body.results[0]?.status).toBe("conflict");
    expect(edit2Body.results[0]?.record?.title).toBe("设备1修改");

    void c2;
  });

  it("远端删除 + 离线编辑 → 冲突；墓碑出现在增量变更中", async () => {
    const cookie = await loginAs(STUDENT);
    const create = await requestAs(cookie, "/evidence/experiences", {
      method: "POST",
      body: JSON.stringify({ title: "将被删除", description: "内容。" }),
      headers: { "Content-Type": "application/json" },
    });
    const exp = await create.json<{ id: string; version: number }>();

    // 离线编辑先发生在本地
    const offlineEdit = { opId: "offline-edit", entity: "experience", entityId: exp.id, baseVersion: exp.version, action: "upsert", payload: { title: "离线编辑", description: "内容。" } };
    // 远端删除先到达服务器
    const del = await requestAs(cookie, `/evidence/experiences/${exp.id}`, { method: "DELETE" });
    expect(del.status).toBe(204);

    // 离线编辑后提交 → conflict（远端已删除，不静默覆盖）
    const res = await requestAs(cookie, "/sync/operations", {
      method: "POST",
      body: JSON.stringify({ operations: [offlineEdit] }),
      headers: { "Content-Type": "application/json" },
    });
    const body = await res.json<{ results: { status: string; record?: { deleted: boolean } }[] }>();
    expect(body.results[0]?.status).toBe("conflict");
    expect(body.results[0]?.record?.deleted).toBe(true);

    // 增量变更含墓碑
    const changes = await requestAs(cookie, "/sync/changes?since=0");
    const changesBody = await changes.json<{ changes: { entityId: string; changeType: string }[] }>();
    expect(changesBody.changes.some((ch) => ch.entityId === exp.id && ch.changeType === "delete")).toBe(true);
  });

  it("删除必须携带当前 baseVersion，缺失或过期版本不会写墓碑", async () => {
    const cookie = await loginAs(STUDENT);
    const create = await requestAs(cookie, "/evidence/experiences", {
      method: "POST",
      body: JSON.stringify({ title: "删除版本检查", description: "内容。" }),
      headers: { "Content-Type": "application/json" },
    });
    const exp = await create.json<{ id: string; version: number }>();

    const missing = await requestAs(cookie, "/sync/operations", {
      method: "POST",
      body: JSON.stringify({ operations: [{ opId: "delete-no-version", entity: "experience", entityId: exp.id, action: "delete" }] }),
      headers: { "Content-Type": "application/json" },
    });
    expect((await missing.json<{ results: { status: string; error: string }[] }>()).results[0]).toMatchObject({ status: "rejected", error: "删除操作必须提供 baseVersion" });

    const stale = await requestAs(cookie, "/sync/operations", {
      method: "POST",
      body: JSON.stringify({ operations: [{ opId: "delete-stale-version", entity: "experience", entityId: exp.id, baseVersion: exp.version - 1, action: "delete" }] }),
      headers: { "Content-Type": "application/json" },
    });
    expect((await stale.json<{ results: { status: string; version?: number }[] }>()).results[0]).toMatchObject({ status: "conflict", version: exp.version });

    const fresh = await requestAs(cookie, "/sync/operations", {
      method: "POST",
      body: JSON.stringify({ operations: [{ opId: "delete-fresh-version", entity: "experience", entityId: exp.id, baseVersion: exp.version, action: "delete" }] }),
      headers: { "Content-Type": "application/json" },
    });
    expect((await fresh.json<{ results: { status: string; version?: number }[] }>()).results[0]).toMatchObject({ status: "applied", version: exp.version + 1 });
  });

  it("并发离线更新只有一个 CAS 成功，实体、日志和两份回执保持一致", async () => {
    const cookie = await loginAs(STUDENT);
    const create = await requestAs(cookie, "/evidence/experiences", {
      method: "POST",
      body: JSON.stringify({ title: "并发起点", description: "内容。" }),
      headers: { "Content-Type": "application/json" },
    });
    const exp = await create.json<{ id: string; version: number }>();
    const operations = ["concurrent-a", "concurrent-b"].map((opId, index) => ({
      opId,
      entity: "experience",
      entityId: exp.id,
      baseVersion: exp.version,
      action: "upsert",
      payload: { title: `并发修改${index}`, description: "内容。" },
    }));
    const responses = await Promise.all(operations.map((op) => requestAs(cookie, "/sync/operations", {
      method: "POST",
      body: JSON.stringify({ operations: [op] }),
      headers: { "Content-Type": "application/json" },
    })));
    const results = await Promise.all(responses.map(async (response) => (await response.json<{ results: { status: string; version?: number; record?: { title?: string; version?: number } }[] }>()).results[0]!));
    const statuses = results.map((result) => result.status);
    expect(statuses.sort()).toEqual(["applied", "conflict"]);
    const applied = results.find((result) => result.status === "applied")!;
    const conflict = results.find((result) => result.status === "conflict")!;
    expect(conflict.version).toBe(exp.version + 1);
    expect(conflict.record).toMatchObject({ version: exp.version + 1, title: applied.record?.title });

    const { mf } = await getMf();
    const db = await mf.getD1Database("DB");
    const row = await db.prepare(`SELECT version FROM experiences WHERE id = ?1`).bind(exp.id).first<{ version: number }>();
    const logs = await db.prepare(`SELECT COUNT(*) AS count FROM change_log WHERE entity_id = ?1 AND version = ?2`).bind(exp.id, exp.version + 1).first<{ count: number }>();
    const receipts = await db.prepare(`SELECT COUNT(*) AS count FROM sync_operations WHERE op_id IN ('concurrent-a', 'concurrent-b')`).first<{ count: number }>();
    expect(Number(row?.version)).toBe(exp.version + 1);
    expect(Number(logs?.count)).toBe(1);
    expect(Number(receipts?.count)).toBe(2);
  });

  it("变更日志写入失败时回滚实体和回执，可安全重试同一操作", async () => {
    const cookie = await loginAs(STUDENT);
    const create = await requestAs(cookie, "/evidence/experiences", {
      method: "POST",
      body: JSON.stringify({ title: "原始标题", description: "内容。" }),
      headers: { "Content-Type": "application/json" },
    });
    const exp = await create.json<{ id: string; version: number }>();
    const { mf } = await getMf();
    const db = await mf.getD1Database("DB");
    await db.prepare(`CREATE TRIGGER fail_experience_log BEFORE INSERT ON change_log WHEN NEW.entity = 'experience' BEGIN SELECT RAISE(ABORT, 'change log failed'); END`).run();

    const operation = { opId: "atomic-retry", entity: "experience", entityId: exp.id, baseVersion: exp.version, action: "upsert", payload: { title: "新标题", description: "内容。" } };
    const failed = await requestAs(cookie, "/sync/operations", {
      method: "POST",
      body: JSON.stringify({ operations: [operation] }),
      headers: { "Content-Type": "application/json" },
    });
    expect((await failed.json<{ results: { status: string }[] }>()).results[0]?.status).toBe("rejected");
    const row = await db.prepare(`SELECT title, version FROM experiences WHERE id = ?1`).bind(exp.id).first<{ title: string; version: number }>();
    const log = await db.prepare(`SELECT COUNT(*) AS count FROM change_log WHERE entity_id = ?1 AND version = ?2`).bind(exp.id, exp.version + 1).first<{ count: number }>();
    const receipt = await db.prepare(`SELECT COUNT(*) AS count FROM sync_operations WHERE op_id = ?1`).bind(operation.opId).first<{ count: number }>();
    expect(row).toMatchObject({ title: "原始标题", version: exp.version });
    expect(Number(log?.count)).toBe(0);
    expect(Number(receipt?.count)).toBe(0);

    await db.prepare(`DROP TRIGGER fail_experience_log`).run();
    const retried = await requestAs(cookie, "/sync/operations", {
      method: "POST",
      body: JSON.stringify({ operations: [operation] }),
      headers: { "Content-Type": "application/json" },
    });
    expect((await retried.json<{ results: { status: string }[] }>()).results[0]?.status).toBe("applied");
  });

  it("用户隔离：看不到别人的变更", async () => {
    const c1 = await loginAs(STUDENT);
    const c2 = await loginAs(STUDENT2);
    await requestAs(c1, "/evidence/experiences", {
      method: "POST",
      body: JSON.stringify({ title: "学生甲的经历", description: "私有。" }),
      headers: { "Content-Type": "application/json" },
    });
    const changes = await requestAs(c2, "/sync/changes?since=0");
    const changesBody = await changes.json<{ changes: { record: { title?: string } }[] }>();
    expect(changesBody.changes.some((ch) => ch.record?.title === "学生甲的经历")).toBe(false);
  });
});
