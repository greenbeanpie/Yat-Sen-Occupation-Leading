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
  await env.DB.batch([
    env.DB
      .prepare(
        `INSERT INTO async_operations (id, user_id, type, status, input_json, input_fingerprint, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'queued', ?4, ?5, ?6, ?6)`,
      )
      .bind(id, userId, type, JSON.stringify(input), fingerprint, nowIso()),
  ]);

  const bindings = env as unknown as Record<string, { create?: (p: { params: { operationId: string } }) => Promise<unknown> } | undefined>;
  const binding = bindings[workflowBindingName(type)];
  if (binding && typeof binding.create === "function") {
    try {
      await binding.create({ params: { operationId: id } });
    } catch (e) {
      logJson("warn", "workflow_dispatch_failed", { type, operationId: id, message: e instanceof Error ? e.message : "?" });
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
