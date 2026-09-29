import { describe, expect, it } from "vitest";
import { loginAs, requestAs, STUDENT } from "./helpers";

describe("画像与证据", () => {
  it("PUT profile 创建后可更新，版本冲突返回 409 + 服务器记录", async () => {
    const cookie = await loginAs(STUDENT);
    const created = await requestAs(cookie, "/profile", {
      method: "PUT",
      body: JSON.stringify({ targetRoles: ["后端开发"], weeklyTimeBudgetHours: 10 }),
      headers: { "Content-Type": "application/json" },
    });
    expect(created.status).toBe(200);
    const createdBody = await created.json<{ version: number; targetRoles: string[] }>();
    expect(createdBody.version).toBe(1);
    expect(createdBody.targetRoles).toEqual(["后端开发"]);

    // 带正确版本更新
    const updated = await requestAs(cookie, "/profile", {
      method: "PUT",
      body: JSON.stringify({ baseVersion: createdBody.version, weeklyTimeBudgetHours: 12 }),
      headers: { "Content-Type": "application/json" },
    });
    expect(updated.status).toBe(200);
    const updatedBody = await updated.json<{ version: number }>();
    expect(updatedBody.version).toBe(2);

    // 用旧版本更新 → 409 + 当前记录
    const conflict = await requestAs(cookie, "/profile", {
      method: "PUT",
      body: JSON.stringify({ baseVersion: createdBody.version, weeklyTimeBudgetHours: 20 }),
      headers: { "Content-Type": "application/json" },
    });
    expect(conflict.status).toBe(409);
    const conflictBody = await conflict.json<{ error: { code: string; server: { version: number } } }>();
    expect(conflictBody.error.code).toBe("version_conflict");
    expect(conflictBody.error.server.version).toBe(2);
  });

  it("经历 CRUD + 证据关联：伪造引用 422 拒绝，原文命中才创建", async () => {
    const cookie = await loginAs(STUDENT);
    const desc = "担任课程项目组长，使用 React 与 TypeScript 完成前端开发，获得课程优秀项目。";
    const expRes = await requestAs(cookie, "/evidence/experiences", {
      method: "POST",
      body: JSON.stringify({ title: "课程项目", kind: "project", description: desc }),
      headers: { "Content-Type": "application/json" },
    });
    expect(expRes.status).toBe(201);
    const exp = await expRes.json<{ id: string; version: number }>();

    const skillRes = await requestAs(cookie, "/evidence/skills", {
      method: "POST",
      body: JSON.stringify({ name: "React" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(skillRes.status).toBe(201);
    const skill = await skillRes.json<{ id: string }>();

    // 伪造引用被拒
    const badLink = await requestAs(cookie, "/evidence/links", {
      method: "POST",
      body: JSON.stringify({ skillId: skill.id, experienceId: exp.id, quote: "使用 Vue 完成前端开发" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(badLink.status).toBe(422);
    const badBody = await badLink.json<{ error: { code: string } }>();
    expect(badBody.error.code).toBe("quote_rejected");

    // 原文命中的引用创建成功
    const link = await requestAs(cookie, "/evidence/links", {
      method: "POST",
      body: JSON.stringify({ skillId: skill.id, experienceId: exp.id, quote: "使用 React 与 TypeScript 完成前端开发" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(link.status).toBe(201);
    const linkBody = await link.json<{ id: string; status: string }>();
    expect(linkBody.status).toBe("pending");

    // 确认证据
    const confirmed = await requestAs(cookie, `/evidence/links/${linkBody.id}`, {
      method: "PUT",
      body: JSON.stringify({ status: "confirmed" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(confirmed.status).toBe(200);
    const confirmedBody = await confirmed.json<{ status: string }>();
    expect(confirmedBody.status).toBe("confirmed");

    const bundle = await requestAs(cookie, "/evidence");
    const bundleBody = await bundle.json<{ experiences: unknown[]; skills: unknown[]; links: { status: string }[] }>();
    expect(bundleBody.experiences.length).toBe(1);
    expect(bundleBody.skills.length).toBe(1);
    expect(bundleBody.links[0]?.status).toBe("confirmed");
  });

  it("经历更新走乐观锁，删除为墓碑", async () => {
    const cookie = await loginAs(STUDENT);
    const expRes = await requestAs(cookie, "/evidence/experiences", {
      method: "POST",
      body: JSON.stringify({ title: "实习", description: "参与服务端开发，负责订单模块。" }),
      headers: { "Content-Type": "application/json" },
    });
    const exp = await expRes.json<{ id: string; version: number }>();

    const updated = await requestAs(cookie, `/evidence/experiences/${exp.id}`, {
      method: "PUT",
      body: JSON.stringify({ baseVersion: exp.version, title: "后端实习", description: "参与服务端开发，负责订单模块。" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(updated.status).toBe(200);
    const updatedBody = await updated.json<{ version: number; title: string }>();
    expect(updatedBody.version).toBe(exp.version + 1);
    expect(updatedBody.title).toBe("后端实习");

    const del = await requestAs(cookie, `/evidence/experiences/${exp.id}`, { method: "DELETE" });
    expect(del.status).toBe(204);

    const bundle = await requestAs(cookie, "/evidence");
    const bundleBody = await bundle.json<{ experiences: unknown[] }>();
    expect(bundleBody.experiences.length).toBe(0);
  });

  it("未登录访问画像返回 401", async () => {
    const res = await requestAs("yso_session=bad.sig", "/profile");
    expect(res.status).toBe(401);
  });
});
