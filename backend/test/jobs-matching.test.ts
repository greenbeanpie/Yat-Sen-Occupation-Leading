import { describe, expect, it } from "vitest";
import { getMf, loginRealAdmin, loginAs, requestAs, STUDENT, STUDENT2 } from "./helpers";
import { runParseJobRequirements, runGenerateMatch } from "../src/application/processors";

async function runProcessor(
  fn: (env: import("../src/env").Env, operationId: string) => Promise<{ status: string; error?: string }>,
  operationId: string,
) {
  const { mf } = await getMf();
  const env = {
    DB: await mf.getD1Database("DB"),
    DOCS: await mf.getR2Bucket("DOCS"),
    AI_PROVIDER: "mock",
    AI_BASE_URL: "",
    AI_MODEL: "",
  } as unknown as import("../src/env").Env;
  return fn(env, operationId);
}

async function setupMatchedJob() {
  const cookie = await loginRealAdmin();
  // 管理员创建并发布公共岗位（JD 含技能关键词，供 mock 引用）
  const create = await requestAs(cookie, "/admin/jobs", {
    method: "POST",
    body: JSON.stringify({
      title: "后端开发工程师",
      company: "示例科技",
      location: "上海",
      jdText: "我们寻找熟悉 TypeScript 的后端工程师。要求掌握 TypeScript 与 Node.js。工作地点上海。本科及以上学历，2026 届毕业生优先。",
    }),
    headers: { "Content-Type": "application/json" },
  });
  expect(create.status).toBe(201);
  const job = await create.json<{ id: string }>();

  const parse = await requestAs(cookie, `/jobs/${job.id}/parse-requirements`, { method: "POST" });
  expect(parse.status).toBe(202);
  const { operationId } = await parse.json<{ operationId: string }>();
  const result = await runProcessor(runParseJobRequirements, operationId);
  expect(result.status).toBe("succeeded");

  const confirm = await requestAs(cookie, `/jobs/${job.id}/requirements/confirm`, { method: "POST" });
  expect(confirm.status).toBe(200);
  const confirmBody = await confirm.json<{ count: number }>();
  expect(confirmBody.count).toBeGreaterThan(0);

  const publish = await requestAs(cookie, `/admin/jobs/${job.id}/publish`, {
    method: "POST",
    body: JSON.stringify({ action: "publish" }),
    headers: { "Content-Type": "application/json" },
  });
  expect(publish.status).toBe(200);
  return job.id;
}

describe("岗位与管理员", () => {
  it("管理员解析 JD 要求并确认写入（引用核验后的候选）", async () => {
    const jobId = await setupMatchedJob();
    const cookie = await loginRealAdmin();
    const detail = await requestAs(cookie, `/jobs/${jobId}`);
    const detailBody = await detail.json<{ requirements: { kind: string; value: string; quote: string }[]; status: string }>();
    expect(detailBody.status).toBe("published");
    expect(detailBody.requirements.some((r) => r.kind === "skill")).toBe(true);
    // 所有已确认要求都带原文引用
    for (const r of detailBody.requirements) {
      expect(r.quote.length).toBeGreaterThan(0);
    }
  });

  it("学生创建私人岗位；他人的私人岗位不可见", async () => {
    const c1 = await loginAs(STUDENT);
    const c2 = await loginAs(STUDENT2);
    const create = await requestAs(c1, "/jobs", {
      method: "POST",
      body: JSON.stringify({ title: "私人 JD：某创业公司前端", jdText: "要求熟悉 Vue3。", sourceUrl: "https://example.com/jd/1" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(create.status).toBe(201);
    const job = await create.json<{ id: string }>();

    const mine = await requestAs(c1, "/jobs?scope=mine");
    const mineBody = await mine.json<{ items: { id: string }[] }>();
    expect(mineBody.items.some((i) => i.id === job.id)).toBe(true);

    const otherView = await requestAs(c2, `/jobs/${job.id}`);
    expect(otherView.status).toBe(404);

    // 学生 B 不能修改学生 A 的私人岗位
    const forbiddenEdit = await requestAs(c2, `/jobs/${job.id}`, {
      method: "PUT",
      body: JSON.stringify({ baseVersion: 1, title: "篡改" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(forbiddenEdit.status).toBe(403);
  });

  it("学生不能访问管理员接口，也不能发布公共岗位", async () => {
    const cookie = await loginAs(STUDENT);
    const list = await requestAs(cookie, "/admin/jobs");
    expect(list.status).toBe(403);
    const create = await requestAs(cookie, "/admin/jobs", {
      method: "POST",
      body: JSON.stringify({ title: "越权岗位" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(create.status).toBe(403);
  });
});

describe("匹配分析", () => {
  it("创建匹配（202）→ 运行 → 读取解释（含输入版本与引用）", async () => {
    const jobId = await setupMatchedJob();
    const cookie = await loginAs(STUDENT);

    const localExperience = await requestAs(cookie, "/matches", {
      method: "POST",
      body: JSON.stringify({ jobId, clientExperienceVersions: [{ id: crypto.randomUUID(), version: 1 }] }),
      headers: { "Content-Type": "application/json" },
    });
    expect(localExperience.status).toBe(409);
    expect((await localExperience.json<{ error: { code: string } }>()).error.code).toBe("sync_required");

    // 画像未同步拦截：客户端声明落后于服务端的版本
    const putProfile = await requestAs(cookie, "/profile", {
      method: "PUT",
      body: JSON.stringify({ targetRoles: ["后端开发"], degree: "bachelor", graduationYear: 2026, preferredLocations: ["上海"] }),
      headers: { "Content-Type": "application/json" },
    });
    expect(putProfile.status).toBe(200);

    const stale = await requestAs(cookie, "/matches", {
      method: "POST",
      body: JSON.stringify({ jobId, clientProfileVersion: 99 }),
      headers: { "Content-Type": "application/json" },
    });
    expect(stale.status).toBe(409);
    const staleBody = await stale.json<{ error: { code: string } }>();
    expect(staleBody.error.code).toBe("sync_required");

    const create = await requestAs(cookie, "/matches", {
      method: "POST",
      body: JSON.stringify({ jobId, clientProfileVersion: 1 }),
      headers: { "Content-Type": "application/json" },
    });
    expect(create.status).toBe(202);
    const { operationId } = await create.json<{ operationId: string }>();
    const result = await runProcessor(runGenerateMatch, operationId);
    expect(result.status).toBe("succeeded");

    const list = await requestAs(cookie, `/matches?jobId=${jobId}`);
    const listBody = await list.json<{ items: { id: string; status: string; scores: { total: number }; hardConditions: { status: string }[]; quotes: unknown[]; inputVersions: unknown }[] }>();
    expect(listBody.items.length).toBeGreaterThan(0);
    const snap = listBody.items[0]!;
    expect(snap.status).toBe("ready");
    expect(snap.hardConditions.length).toBeGreaterThan(0);
    expect(snap.inputVersions).toBeTruthy();
    // 分析结果必须返回输入版本与引用列表（PLAN.md 三）
    expect(Array.isArray(snap.quotes)).toBe(true);
  });
});
