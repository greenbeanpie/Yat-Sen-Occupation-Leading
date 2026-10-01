import { describe, expect, it, vi, afterEach } from "vitest";
import { createApp } from "../src/app";
import { seedInvitation, getMf, loginAs, loginRealAdmin, request, requestAs, ADMIN, STUDENT, STUDENT2 } from "./helpers";
import type { Env } from "../src/env";
import { startOperation } from "../src/application/operations";
import { runParseDocument, runGeneratePlan, runGenerateMatch } from "../src/application/processors";
import { cronTick, createReminder } from "../src/application/reminders";
import { sessionSecret } from "../src/infra/db/helpers";
import { hashPassword, verifyPassword } from "../src/infra/password";
import { OpenAiCompatProvider } from "../src/infra/ai";
import { logJson } from "../src/infra/logger";
import { buildMinimalDocx } from "./fixtures/docx";

const json = (body: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
async function environment(): Promise<Env> {
  const { mf } = await getMf();
  return { DB: await mf.getD1Database("DB"), DOCS: await mf.getR2Bucket("DOCS"), AI_PROVIDER: "mock", AI_BASE_URL: "", AI_MODEL: "", DEMO_ENABLED: "true", SESSION_SECRET: "test-secret-with-at-least-32-bytes-long", CORS_ORIGIN: "http://localhost:5173" } as unknown as Env;
}
async function realAccount() {
  const response = await request(undefined, "/session/register", json({ invitationCode: await seedInvitation(), username: "regression_user", password: crypto.randomUUID() }));
  expect(response.status).toBe(200);
  return { cookie: response.headers.get("set-cookie")!.split(";")[0]!, userId: (await response.json<{ user: { id: string } }>()).user.id };
}
async function job(cookie: string) {
  const response = await requestAs(cookie, "/jobs", json({ title: "私人岗位", jdText: "React developer" }));
  expect(response.status).toBe(201); return (await response.json<{ id: string }>()).id;
}
async function document(cookie: string, bytes = buildMinimalDocx(["项目经历", "使用 React 和 TypeScript 开发管理后台。"]), mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
  // Use the repository's raw multipart precedent across Node/undici/workerd.
  const boundary = `----audit${crypto.randomUUID()}`;
  const head = new TextEncoder().encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="resume.docx"\r\nContent-Type: ${mime}\r\n\r\n`);
  const tail = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(head.length + bytes.length + tail.length); body.set(head); body.set(bytes, head.length); body.set(tail, head.length + bytes.length);
  const { mf } = await getMf();
  return mf.dispatchFetch("http://yso.test/api/v1/documents", { method: "POST", body, headers: { Cookie: cookie, "Content-Type": `multipart/form-data; boundary=${boundary}` } } as never) as unknown as Promise<Response>;
}
afterEach(() => vi.restoreAllMocks());

describe("审计安全边界回归", () => {
  it("公开演示管理员不能读取公共草稿、改变共享岗位或真实私人数据", async () => {
    const admin = await loginRealAdmin(); const demo = await loginAs(ADMIN); const real = await realAccount();
    const response = await requestAs(admin, "/admin/jobs", json({ title: "真实公共草稿", jdText: "TypeScript" })); expect(response.status).toBe(201);
    const { id } = await response.json<{ id: string }>(); const privateId = await job(real.cookie);
    expect((await requestAs(demo, "/admin/jobs")).status).toBe(403);
    expect((await requestAs(demo, `/jobs/${id}`)).status).toBe(404);
    expect((await requestAs(demo, `/jobs/${privateId}`)).status).toBe(404);
    for (const target of [id, privateId]) {
      expect((await requestAs(demo, `/jobs/${target}`, { ...json({ baseVersion: 1, title: "篡改" }), method: "PUT" })).status).toBe(403);
      expect((await requestAs(demo, `/jobs/${target}`, { method: "DELETE" })).status).toBe(403);
      expect((await requestAs(demo, `/jobs/${target}/parse-requirements`, { method: "POST" })).status).toBe(403);
    }
    expect((await requestAs(demo, `/admin/jobs/${id}/publish`, json({ action: "publish" }))).status).toBe(403);
    expect((await requestAs(admin, `/admin/jobs/${id}/publish`, json({ action: "publish" }))).status).toBe(200);
  });
  it("真实账号不能凭公开 UUID 直登，口令注册流程仍有效", async () => {
    const account = await realAccount();
    expect((await request(undefined, "/session", json({ userId: account.userId }))).status).toBe(404);
    expect((await requestAs(account.cookie, "/profile")).status).toBe(200);
  });
  it("关闭演示时拒绝直登及旧演示 Cookie，但真实会话可用", async () => {
    const demoCookie = await loginAs(STUDENT); const account = await realAccount(); const env = await environment(); env.DEMO_ENABLED = "false";
    const app = createApp();
    expect((await app.request("/api/v1/session", json({ userId: STUDENT }), env)).status).toBe(404);
    const session = await app.request("/api/v1/session", {}, env);
    expect(await session.json()).toMatchObject({ authenticated: false });
    expect((await app.request("/api/v1/profile", { headers: { Cookie: demoCookie } }, env)).status).toBe(401);
    expect((await app.request("/api/v1/profile", { headers: { Cookie: account.cookie } }, env)).status).toBe(200);
  });
  it("缺失或过短 SESSION_SECRET 不再使用公开值", () => {
    expect(() => sessionSecret({} as Env)).toThrow(); expect(() => sessionSecret({ SESSION_SECRET: "short" } as Env)).toThrow();
  });
  it("登出后重放旧 Cookie 被拒绝，其他独立会话不受影响", async () => {
    const a = await loginAs(STUDENT), b = await loginAs(STUDENT);
    expect((await requestAs(a, "/session", { method: "DELETE" })).status).toBe(204);
    expect((await requestAs(a, "/profile")).status).toBe(401);
    expect((await requestAs(b, "/profile")).status).toBe(200);
    expect((await requestAs(b + ".extra", "/profile")).status).toBe(401);
  });
  it("私人 published 岗位仍不可被他人匹配；处理器拒绝绕过入口的旧作业", async () => {
    const a = await loginAs(STUDENT), b = await loginAs(STUDENT2); const id = await job(a); const env = await environment();
    await env.DB.prepare("UPDATE jobs SET status = 'published' WHERE id = ?1").bind(id).run();
    expect((await requestAs(b, "/matches", json({ jobId: id }))).status).toBe(404);
    const operation = await startOperation(env, STUDENT2, "generate_match", { jobId: id }, [id]);
    expect(await runGenerateMatch(env, operation)).toMatchObject({ status: "failed" });
  });
  it("REST/sync 创建和更新都拒绝他人的父引用；同账号引用保留", async () => {
    const a = await loginAs(STUDENT), b = await loginAs(STUDENT2); const id = await job(a);
    expect((await requestAs(b, "/applications", json({ jobId: id, jobTitle: "其他人岗位" }))).status).toBe(404);
    const ownApp = await requestAs(a, "/applications", json({ jobId: id, jobTitle: "本人岗位" })); expect(ownApp.status).toBe(201);
    const applicationId = (await ownApp.json<{ id: string }>()).id;
    const response = await requestAs(b, "/sync/operations", json({ operations: [
      { opId: "foreign-interview", entity: "interview", entityId: crypto.randomUUID(), baseVersion: 0, action: "upsert", payload: { applicationId, stage: "一面", scheduledAt: "2026-11-01T00:00:00.000Z" } },
      { opId: "foreign-portfolio", entity: "portfolio", entityId: crypto.randomUUID(), baseVersion: 0, action: "upsert", payload: { timeBudgetHours: 5, items: [{ jobId: id }] } },
    ] }));
    expect((await response.json<{ results: { status: string }[] }>()).results.map(item => item.status)).toEqual(["rejected", "rejected"]);
    const localApp = await requestAs(b, "/applications", json({ jobTitle: "本人手动记录" })); const localId = (await localApp.json<{ id: string }>()).id;
    expect((await requestAs(b, `/applications/${localId}`, { ...json({ baseVersion: 1, jobId: id }), method: "PATCH" })).status).toBe(404);
  });
  it("旧组合任意 jobId 不能将他人标题送入生成计划", async () => {
    const a = await loginAs(STUDENT); const jobId = await job(a); const env = await environment(); const portfolioId = crypto.randomUUID(); const now = new Date().toISOString();
    await env.DB.prepare("INSERT INTO portfolios (id,user_id,time_budget_hours,items_json,created_at,updated_at) VALUES (?1,?2,5,?3,?4,?4)").bind(portfolioId, STUDENT2, JSON.stringify([{ jobId, selected: true }]), now).run();
    const op = await startOperation(env, STUDENT2, "generate_plan", { portfolioId }, [portfolioId]);
    expect(await runGeneratePlan(env, op)).toMatchObject({ status: "failed" });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM plan_tasks WHERE user_id = ?1").bind(STUDENT2).first<{ n: number }>())?.n).toBe(0);
  });
  it("删除原文件、草稿与片段；已排队解析/再次确认不能复活文档", async () => {
    const cookie = await loginAs(STUDENT); const uploaded = await document(cookie); expect(uploaded.status).toBe(201); const id = (await uploaded.json<{ id: string }>()).id;
    const parsed = await requestAs(cookie, `/documents/${id}/parse`, { method: "POST" }); const { operationId } = await parsed.json<{ operationId: string }>();
    const env = await environment(); const row = await env.DB.prepare("SELECT r2_key FROM documents WHERE id = ?1").bind(id).first<{ r2_key: string }>();
    expect((await requestAs(cookie, `/documents/${id}`, { method: "DELETE" })).status).toBe(204);
    expect(await env.DOCS.get(row!.r2_key)).toBeNull(); expect(await runParseDocument(env, operationId)).toMatchObject({ status: "failed" });
    for (const suffix of ["", "/draft", "/content"]) expect((await requestAs(cookie, `/documents/${id}${suffix}`)).status).toBe(404);
    expect((await requestAs(cookie, `/documents/${id}/confirm`, json({ confirm: true }))).status).toBe(404);
    expect((await requestAs(cookie, `/documents/${id}`, { method: "DELETE" })).status).toBe(204);
  });
  it("解析过程中删除文档也不能写回草稿/片段", async () => {
    const cookie = await loginAs(STUDENT); const id = (await (await document(cookie)).json<{ id: string }>()).id;
    const operationId = (await (await requestAs(cookie, `/documents/${id}/parse`, { method: "POST" })).json<{ operationId: string }>()).operationId;
    const env = await environment(); const realBucket = env.DOCS;
    env.DOCS = { get: async (key: string) => { const object = await realBucket.get(key); await requestAs(cookie, `/documents/${id}`, { method: "DELETE" }); return object; } } as unknown as R2Bucket;
    expect(await runParseDocument(env, operationId)).toMatchObject({ status: "failed" });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM parse_drafts WHERE document_id = ?1").bind(id).first<{ n: number }>())?.n).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM document_segments WHERE document_id = ?1").bind(id).first<{ n: number }>())?.n).toBe(0);
  });
  it("并发确认同一草稿只写一次", async () => {
    const cookie = await loginAs(STUDENT); const id = (await (await document(cookie)).json<{ id: string }>()).id;
    const op = (await (await requestAs(cookie, `/documents/${id}/parse`, { method: "POST" })).json<{ operationId: string }>()).operationId;
    const env = await environment(); expect(await runParseDocument(env, op)).toMatchObject({ status: "succeeded" });
    const responses = await Promise.all([requestAs(cookie, `/documents/${id}/confirm`, json({ confirm: true })), requestAs(cookie, `/documents/${id}/confirm`, json({ confirm: true }))]);
    expect(responses.filter(response => response.status === 200)).toHaveLength(1);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM experiences WHERE source_document_id = ?1").bind(id).first<{ n: number }>(); expect(count?.n).toBe(1);
  });
  it("同指纹并发作业去重，不同输入超过并发上限返回 429", async () => {
    const env = await environment(); const ids = await Promise.all([startOperation(env, STUDENT, "generate_plan", {}, [1]), startOperation(env, STUDENT, "generate_plan", {}, [1])]); expect(ids[0]).toBe(ids[1]);
    await startOperation(env, STUDENT, "generate_plan", {}, [2]); await startOperation(env, STUDENT, "generate_plan", {}, [3]);
    await expect(startOperation(env, STUDENT, "generate_plan", {}, [4])).rejects.toMatchObject({ status: 429 });
  });
  it("入口限流返回统一 429、Retry-After、Request-Id", async () => {
    for (let i = 0; i < 20; i++) expect((await request(undefined, "/session", json({ userId: STUDENT }))).status).toBe(200);
    const denied = await request(undefined, "/session", json({ userId: STUDENT })); expect(denied.status).toBe(429); expect(denied.headers.get("Retry-After")).toBe("60"); expect(denied.headers.get("X-Request-Id")).toBeTruthy();
  });
  it("伪造 MIME 文件在保存 R2 前被拒绝", async () => {
    const cookie = await loginAs(STUDENT); const bucket = (await environment()).DOCS; const before = (await bucket.list()).objects.length;
    expect((await document(cookie, new TextEncoder().encode("not-pdf"), "application/pdf")).status).toBe(422);
    expect((await bucket.list()).objects).toHaveLength(before);
  });
  it("真实账号不能触发演示 reset；演示 reset 删除 R2 文件", async () => {
    const account = await realAccount(); expect((await requestAs(account.cookie, "/demo/reset", { method: "POST" })).status).toBe(403);
    const cookie = await loginAs(STUDENT); expect((await document(cookie)).status).toBe(201);
    expect((await requestAs(cookie, "/demo/reset", { method: "POST" })).status).toBe(200);
    expect((await (await environment()).DOCS.list({ prefix: `docs/${STUDENT}/` })).objects).toHaveLength(0);
  });
  it("REST/sync 都拒绝非 HTTP(S) sourceUrl，并允许正常链接", async () => {
    const cookie = await loginAs(STUDENT);
    for (const sourceUrl of ["javascript:alert(1)", "data:text/html,hi", "java\nscript:alert(1)", "//evil.example"]) expect((await requestAs(cookie, "/jobs", json({ title: "bad", sourceUrl }))).status).toBe(422);
    const sync = await requestAs(cookie, "/sync/operations", json({ operations: [{ opId: "bad-link", entity: "job", entityId: crypto.randomUUID(), baseVersion: 0, action: "upsert", payload: { title: "bad", sourceUrl: "javascript:alert(1)" } }] }));
    expect((await sync.json<{ results: { status: string }[] }>()).results[0]?.status).toBe("rejected");
    expect((await requestAs(cookie, "/jobs", json({ title: "safe", sourceUrl: "https://example.com/job" }))).status).toBe(201);
  });
  it("列表提供下一页且 q/degree 组合过滤不会错位", async () => {
    const env = await environment(); const now = new Date().toISOString();
    await env.DB.batch(Array.from({ length: 105 }, () => env.DB.prepare("INSERT INTO jobs (id,user_id,title,degree_requirement,status,created_at,updated_at) VALUES (?1,NULL,'React','bachelor','published',?2,?2)").bind(crypto.randomUUID(), now)));
    const cookie = await loginAs(STUDENT); const first = await requestAs(cookie, "/jobs?q=React&degree=bachelor"); const page = await first.json<{ items: unknown[]; nextCursor: string }>(); expect(page.items).toHaveLength(100); expect(page.nextCursor).toBe("100");
    const last = await requestAs(cookie, `/jobs?q=React&degree=bachelor&cursor=${page.nextCursor}`); const lastPage = await last.json<{ items: unknown[]; nextCursor: string | null }>(); expect(lastPage.nextCursor).toBeNull(); expect(lastPage.items).toHaveLength(5);
  });
  it("推送暂时失败下一轮重试，成功订阅不重复推送，站内通知不丢", async () => {
    const env = await environment(); const now = new Date().toISOString(); const reminderId = crypto.randomUUID();
    await loginAs(STUDENT); const session = await env.DB.prepare('SELECT id FROM sessions WHERE user_id=?1').bind(STUDENT).first<{id:string}>();
    await createReminder(env, STUDENT, { entity: "task", entityId: reminderId, entityVersion: 1, kind: "task_due", fireAt: "2020-01-01T00:00:00.000Z", title: "提醒" });
    for (const endpoint of ["https://push.example/a", "https://push.example/b"]) await env.DB.prepare("INSERT INTO push_subscriptions (id,user_id,endpoint,p256dh,auth,created_at,updated_at,session_id) VALUES (?1,?2,?3,'key','auth',?4,?4,?5)").bind(crypto.randomUUID(), STUDENT, endpoint, now,session!.id).run();
    let first = true; const calls: string[] = [];
    const push = vi.fn(async (_env: Env, sub: { endpoint: string }) => { calls.push(sub.endpoint); if (sub.endpoint.endsWith('/b') && first) throw Object.assign(new Error("temporary"), { statusCode: 503 }); return { ok: true, statusCode: 201 }; });
    expect((await cronTick(env, now, push)).sentPush).toBe(1); first = false; expect((await cronTick(env, now, push)).sentPush).toBe(1);
    expect(calls.filter(endpoint => endpoint.endsWith('/a'))).toHaveLength(1);
    expect((await env.DB.prepare("SELECT status,retry_count FROM reminders WHERE user_id=?1").bind(STUDENT).first())).toMatchObject({ status: "sent", retry_count: -1 });
  });
  it("上传期间删除或重置完成后，晚到的 R2 put 必须清除", async () => {
    for (const reset of [false, true]) {
      const cookie = await loginAs(STUDENT); const env = await environment(); const bucket = env.DOCS;
      const originalPut = bucket.put.bind(bucket);
      env.DOCS = { put: async (key: string, body: ReadableStream, options: R2PutOptions) => {
        const row = await env.DB.prepare("SELECT id FROM documents WHERE r2_key=?1").bind(key).first<{ id: string }>();
        expect(row).toBeTruthy();
        const path = reset ? "/demo/reset" : `/documents/${row!.id}`;
        expect((await requestAs(cookie, path, { method: reset ? "POST" : "DELETE" })).status).toBe(reset ? 200 : 204);
        // Node's injected stream lacks workerd's fixed-length metadata; the test
        // adapter supplies bytes to the real R2 binding after the race hook.
        return originalPut(key, await new Response(body).arrayBuffer(), options);
      }, delete: bucket.delete.bind(bucket) } as unknown as R2Bucket;
      const form = new FormData(); form.set("file", new File([buildMinimalDocx(["经历"]).buffer as ArrayBuffer], "race.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }));
      const app = createApp();
      const response = await app.request("/api/v1/documents", { method: "POST", headers: { Cookie: cookie }, body: form }, env);
      expect(response.status).toBe(409);
      expect((await bucket.list({ prefix: `docs/${STUDENT}/` })).objects).toHaveLength(0);
    }
  });
  it("推送查询失败后仍可重试，超时 running 作业释放并发槽", async () => {
    const env = await environment(); const db = env.DB; const now = new Date().toISOString();
    await createReminder(env, STUDENT, { entity: "task", entityId: crypto.randomUUID(), entityVersion: 1, kind: "task_due", fireAt: "2020-01-01T00:00:00.000Z", title: "提醒" });
    await loginAs(STUDENT); const session = await db.prepare('SELECT id FROM sessions WHERE user_id=?1').bind(STUDENT).first<{id:string}>();
    await db.prepare("INSERT INTO push_subscriptions (id,user_id,endpoint,p256dh,auth,created_at,updated_at,session_id) VALUES (?1,?2,'https://push.example/a','key','auth',?3,?3,?4)").bind(crypto.randomUUID(), STUDENT, now,session!.id).run();
    env.DB = { prepare: (sql: string) => { if (sql.includes("SELECT s.* FROM push_subscriptions")) throw new Error("injected D1 failure"); return db.prepare(sql); }, batch: db.batch.bind(db) } as unknown as D1Database;
    await expect(cronTick(env, now)).rejects.toThrow("injected"); env.DB = db;
    const push = vi.fn(async () => ({ ok: true, statusCode: 201 }));
    expect((await cronTick(env, now, push)).sentPush).toBe(1);
    const id = await startOperation(env, STUDENT, "generate_plan", {}, ["old-running"]);
    await db.prepare("UPDATE async_operations SET status='running',updated_at='2020-01-01T00:00:00.000Z' WHERE id=?1").bind(id).run();
    await cronTick(env, now, push);
    expect(await db.prepare("SELECT status FROM async_operations WHERE id=?1").bind(id).first()).toMatchObject({ status: "failed" });
  });
  it("密码新参数与破损/高迭代存储串处理", async () => {
    const stored = await hashPassword("regression password"); expect(stored).toContain("scrypt$32768$8$3$"); expect(await verifyPassword("regression password", stored)).toBe(true); expect(await verifyPassword("wrong", stored)).toBe(false);
    expect(await verifyPassword("test", "pbkdf2-sha256$10000000$bad$bad")).toBe(false); expect(await verifyPassword("test", "pbkdf2-sha256$100000$!!!$!!!")).toBe(false);
  });
  it("过大真实模型输入在联网前拒绝，正常请求限制输出 tokens", async () => {
    const provider = new OpenAiCompatProvider({ AI_BASE_URL: "https://model.example", AI_MODEL: "test" } as Env);
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), { headers: { "Content-Type": "application/json" } }));
    await expect(provider.complete([{ role: "user", content: "a".repeat(100001) }])).rejects.toThrow("100KB"); expect(fetch).not.toHaveBeenCalled();
    await provider.complete([{ role: "user", content: "hello" }]); expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string).max_tokens).toBe(4096);
  });
  it("日志不输出 PII 和未处理错误原文", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {}); logJson("error", "test", { username: "person", message: "secret SQL", nested: { filename: "resume" } });
    const line = spy.mock.calls[0]![0] as string; expect(line).not.toContain("person"); expect(line).not.toContain("secret SQL"); expect(line).not.toContain('"resume"');
  });
});
