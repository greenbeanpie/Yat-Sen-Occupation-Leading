import { describe, expect, it } from "vitest";
// 直接使用 createApp，避免把 Workflows 入口（cloudflare:workers）拉进 Node 测试池。
import { createApp } from "../src/app";
import type { Env } from "../src/env";
import { getMf, loginAs, requestAs, STUDENT, STUDENT2 } from "./helpers";

async function seedStudentData(cookie: string): Promise<void> {
  const profile = await requestAs(cookie, "/profile", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetRoles: ["数据分析实习生"], industries: ["互联网"], preferredLocations: ["广州"] }),
  });
  expect(profile.status).toBe(200);

  const job = await requestAs(cookie, "/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "私人岗位", company: "示例公司", jdText: "岗位职责：整理数据；任职要求：熟悉 SQL。" }),
  });
  expect(job.status).toBe(201);

  const application = await requestAs(cookie, "/applications", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobId: null, jobTitle: "数据分析实习生", company: "示例公司", status: "preparing", notes: "" }),
  });
  expect(application.status).toBe(201);
}

describe("演示数据重置", () => {
  it("清空当前身份的业务数据，但保留公共岗位与其他身份的数据", async () => {
    const admin = await loginAs("10000000-0000-4000-8000-0000000000ff");
    const created = await requestAs(admin, "/admin/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "公共岗位", company: "公开公司", jdText: "任职要求：本科在读。" }),
    });
    expect(created.status).toBe(201);
    const jobId = (await created.json<{ id: string }>()).id;
    const published = await requestAs(admin, `/admin/jobs/${jobId}/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "publish" }),
    });
    expect(published.status).toBe(200);

    const student = await loginAs(STUDENT);
    await seedStudentData(student);
    const other = await loginAs(STUDENT2);
    await seedStudentData(other);

    const reset = await requestAs(student, "/demo/reset", { method: "POST" });
    expect(reset.status).toBe(200);
    const body = await reset.json<{ reset: boolean; deletedRows: number }>();
    expect(body.reset).toBe(true);
    expect(body.deletedRows).toBeGreaterThan(0);

    const profile = await requestAs(student, "/profile");
    expect(await profile.json<{ version: number; targetRoles: string[] }>()).toMatchObject({ version: 0, targetRoles: [] });

    const privateJobs = await requestAs(student, "/jobs?scope=mine");
    expect(await privateJobs.json<{ items: unknown[] }>()).toMatchObject({ items: [] });

    const applications = await requestAs(student, "/applications");
    expect(await applications.json<{ items: unknown[] }>()).toMatchObject({ items: [] });

    // 公共岗位库与其他演示身份不受影响。
    const publicJobs = await requestAs(student, "/jobs?scope=public");
    const publicItems = await publicJobs.json<{ items: { id: string }[] }>();
    expect(publicItems.items.map((item) => item.id)).toContain(jobId);

    const otherProfile = await requestAs(other, "/profile");
    expect(await otherProfile.json<{ targetRoles: string[] }>()).toMatchObject({ targetRoles: ["数据分析实习生"] });
    const otherJobs = await requestAs(other, "/jobs?scope=mine");
    expect((await otherJobs.json<{ items: unknown[] }>()).items).toHaveLength(1);
  });

  it("非演示环境返回 403", async () => {
    const { mf } = await getMf();
    const DB = await mf.getD1Database("DB");
    const cookie = await loginAs(STUDENT);
    const response = await createApp().request("/api/v1/demo/reset", { method: "POST", headers: { Cookie: cookie } }, {
      DB,
      DEMO_ENABLED: "false",
      SESSION_SECRET: "test-secret",
    } as unknown as Env);
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("forbidden");
  });
});
