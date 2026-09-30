import { AppError } from "../shared/errors";
import type { Env } from "../env";
import type { OperationType } from "../shared/constants";
import { nowIso, uuid } from "../shared/datetime";
import { fingerprintOf } from "../infra/db/helpers";
import { logJson } from "../infra/logger";

/** 创建异步作业记录并派发 Workflow（绑定缺失时只落记录，测试环境直接调用处理器）。 */
export async function startOperation(
  env: Env,
  userId: string,
  type: OperationType,
  input: Record<string, unknown>,
  fingerprintParts: unknown[],
): Promise<string> {
  const id = uuid();
  const fingerprint = await fingerprintOf(fingerprintParts);
  const prior = await env.DB.prepare(`SELECT id FROM async_operations WHERE user_id = ?1 AND type = ?2 AND input_fingerprint = ?3 AND status IN ('queued', 'running')`).bind(userId, type, fingerprint).first<{ id: string }>();
  if (prior) return prior.id;
  const reserved = await env.DB.batch([
    env.DB
      .prepare(
        `INSERT INTO async_operations (id, user_id, type, status, input_json, input_fingerprint, created_at, updated_at)
         SELECT ?1, ?2, ?3, 'queued', ?4, ?5, ?6, ?6
         WHERE (SELECT COUNT(*) FROM async_operations WHERE user_id = ?2 AND status IN ('queued','running')) < 3
         AND (SELECT COUNT(*) FROM async_operations WHERE user_id = ?2 AND created_at >= ?7) < 50
         AND NOT EXISTS (SELECT 1 FROM async_operations WHERE user_id = ?2 AND type = ?3 AND input_fingerprint = ?5 AND status IN ('queued','running'))`,
      )
      .bind(id, userId, type, JSON.stringify(input), fingerprint, nowIso(), new Date(Date.now() - 86400_000).toISOString()),
  ]);

  if (Number(reserved[0]?.meta.changes) !== 1) {
    const concurrent = await env.DB.prepare(`SELECT id FROM async_operations WHERE user_id = ?1 AND type = ?2 AND input_fingerprint = ?3 AND status IN ('queued','running')`).bind(userId, type, fingerprint).first<{ id: string }>();
    if (concurrent) return concurrent.id;
    throw new AppError(429, "operation_quota", "最多同时处理 3 个作业，每 24 小时最多发起 50 个，请稍后重试");
  }
  const bindings = env as unknown as Record<string, { create?: (p: { id?: string; params: { operationId: string } }) => Promise<unknown> } | undefined>;
  const binding = bindings[workflowBindingName(type)];
  if (binding && typeof binding.create === "function") {
    try {
      await binding.create({ id, params: { operationId: id } });
    } catch (e) {
      logJson("warn", "workflow_dispatch_failed", { type, operationId: id, message: e instanceof Error ? e.message : "?" });
      const error = e instanceof Error ? e.message : "workflow dispatch failed";
      await env.DB
        .prepare(`UPDATE async_operations SET status = 'failed', error = ?1, updated_at = ?2 WHERE id = ?3 AND status = 'queued'`)
        .bind(error, nowIso(), id)
        .run();
    }
  }
  return id;
}

function workflowBindingName(type: OperationType): string {
  switch (type) {
    case "parse_document":
      return "PARSE_DOCUMENT";
    case "parse_job_requirements":
      return "PARSE_JOB_REQUIREMENTS";
    case "generate_match":
      return "GENERATE_MATCH";
    case "generate_plan":
      return "GENERATE_PLAN";
    case "rewrite_resume":
      return "REWRITE_RESUME";
  }
}
