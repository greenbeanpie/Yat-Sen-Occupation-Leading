import type { Env } from "../env";
import { invalidRequest, notFound } from "../shared/errors";

/** A published private job remains private; only ownerless published jobs are public. */
export async function visibleJob(env: Env, userId: string, id: string): Promise<Record<string, unknown>> {
  const row = await env.DB.prepare(`SELECT * FROM jobs WHERE id = ?1 AND deleted = 0
    AND (user_id = ?2 OR (user_id IS NULL AND status = 'published'))`).bind(id, userId).first<Record<string, unknown>>();
  if (!row) throw notFound("岗位不存在");
  return row;
}

export function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 1000) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && Boolean(url.hostname) && !url.username && !url.password;
  } catch { return false; }
}

/** Shared REST/sync boundary: validate only references provided by this mutation. */
export async function validateReferences(env: Env, userId: string, table: string, payload: Record<string, unknown>): Promise<void> {
  const own = async (parent: string, value: unknown) => {
    if (value == null) return;
    if (typeof value !== "string") throw invalidRequest([{ field: parent, issue: "引用必须是 ID" }]);
    const row = await env.DB.prepare(`SELECT id FROM ${parent} WHERE id = ?1 AND user_id = ?2 AND deleted = 0`).bind(value, userId).first();
    if (!row) throw notFound("关联记录不存在");
  };
  const job = async (value: unknown) => {
    if (value == null) return;
    if (typeof value !== "string") throw invalidRequest([{ field: "jobId", issue: "引用必须是 ID" }]);
    await visibleJob(env, userId, value);
  };
  if (table === "jobs" && payload.sourceUrl != null && !isHttpUrl(payload.sourceUrl)) {
    throw invalidRequest([{ field: "sourceUrl", issue: "来源链接必须是绝对 HTTP(S) URL，且不包含账号口令" }]);
  }
  if (["applications", "plan_tasks"].includes(table)) await job(payload.jobId);
  if (["application_events", "interviews", "time_entries"].includes(table)) await own("applications", payload.applicationId);
  if (table === "time_entries") await own("plan_tasks", payload.taskId);
  if (table === "experiences") await own("documents", payload.sourceDocumentId);
  if (table === "experience_skills") {
    await own("skills", payload.skillId);
    await own("experiences", payload.experienceId);
  }
  if (table === "plan_tasks") {
    await own("experience_skills", payload.evidenceId);
    if (payload.deps != null) {
      if (!Array.isArray(payload.deps)) throw invalidRequest([{ field: "deps", issue: "依赖必须是 ID 列表" }]);
      for (const id of payload.deps) await own("plan_tasks", id);
    }
  }
  if (table === "portfolios" && payload.items != null) {
    if (!Array.isArray(payload.items)) throw invalidRequest([{ field: "items", issue: "岗位必须是列表" }]);
    for (const item of payload.items) {
      if (!item || typeof item !== "object" || !("jobId" in item)) throw invalidRequest([{ field: "items", issue: "岗位必须有 jobId" }]);
      await job((item as { jobId: unknown }).jobId);
    }
  }
}
