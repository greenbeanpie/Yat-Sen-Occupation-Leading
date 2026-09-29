import { describe, expect, it } from "vitest";
import { ADMIN, loginAs, request, requestAs, STUDENT, STUDENT2 } from "./helpers";

describe("session（演示身份）", () => {
  it("未登录时返回演示身份列表", async () => {
    const res = await request(undefined, "/session");
    expect(res.status).toBe(200);
    const body = await res.json<{ authenticated: boolean; demoUsers: unknown[] }>();
    expect(body.authenticated).toBe(false);
    expect(body.demoUsers?.length).toBe(3);
  });

  it("登录后返回身份与角色，角色由服务端决定", async () => {
    const cookie = await loginAs(ADMIN);
    const res = await requestAs(cookie, "/session");
    expect(res.status).toBe(200);
    const body = await res.json<{ authenticated: boolean; user: { role: string; demo: boolean } }>();
    expect(body.authenticated).toBe(true);
    expect(body.user?.role).toBe("admin");
    expect(body.user?.demo).toBe(true);
  });

  it("未知用户登录返回 404", async () => {
    const res = await request(undefined, "/session", {
      method: "POST",
      body: JSON.stringify({ userId: "00000000-0000-4000-8000-000000000000" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(404);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("not_found");
  });

  it("登出清除会话", async () => {
    const cookie = await loginAs(STUDENT);
    const res = await requestAs(cookie, "/session", { method: "DELETE" });
    expect(res.status).toBe(204);
  });

  it("非法 userId 触发字段级 422", async () => {
    const res = await request(undefined, "/session", {
      method: "POST",
      body: JSON.stringify({ userId: "not-a-uuid" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(422);
    const body = await res.json<{ error: { details: { field: string }[] } }>();
    expect(body.error.details?.[0]?.field).toBe("userId");
  });

  it("每个身份独立会话", async () => {
    const c1 = await loginAs(STUDENT);
    const c2 = await loginAs(STUDENT2);
    const b1 = await (await requestAs(c1, "/session")).json<{ user: { id: string } }>();
    const b2 = await (await requestAs(c2, "/session")).json<{ user: { id: string } }>();
    expect(b1.user?.id).toBe(STUDENT);
    expect(b2.user?.id).toBe(STUDENT2);
  });
});

describe("openapi 契约", () => {
  it("导出的契约包含 session 与 profile 域", async () => {
    const res = await request(undefined, "/openapi.json");
    expect(res.status).toBe(200);
    const doc = await res.json<{ paths: Record<string, unknown> }>();
    expect(Object.keys(doc.paths)).toContain("/api/v1/session");
    expect(Object.keys(doc.paths)).toContain("/api/v1/profile");
  });

  it("未知接口返回统一 404 包络", async () => {
    const res = await request(undefined, "/nope");
    expect(res.status).toBe(404);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("not_found");
  });
});
