import { getConfiguredAiProvider } from '../infra/ai/settings';
import { z } from "zod";
import type { Env } from "../env";
import { AiError } from "../infra/ai";
import { verifyQuote } from "../domain/quotes";
import { nowIso } from "../shared/datetime";
import type { ProcessorResult } from "./processors";
import { fingerprintOf } from "../infra/db/helpers";

const ModelRequirementsResponse = z.object({
  requirements: z
    .array(
      z.object({
        kind: z.enum(["degree", "location", "graduation_year", "skill", "experience", "other"]),
        value: z.string().max(200),
        quote: z.string().max(500),
      }),
    )
    .max(30)
    .default([]),
});

/**
 * 岗位 JD 要求解析（管理员/私人 JD 的“解析确认”流程）：
 * 模型从 JD 原文提取候选硬条件 → 引用核验 → 结果存于作业记录，用户确认后才写入岗位。
 */
export async function processParseJobRequirements(env: Env, operationId: string): Promise<ProcessorResult> {
  const op = await env.DB.prepare(`SELECT * FROM async_operations WHERE id = ?1`).bind(operationId).first<Record<string, unknown>>();
  if (!op) return { status: "failed", error: "作业不存在" };
  if (op.status === "succeeded") return { status: "succeeded" };

  const userId = op.user_id as string;
  const input = JSON.parse(op.input_json as string) as { jobId: string };
  const job = await env.DB.prepare(`SELECT * FROM jobs WHERE id = ?1 AND deleted = 0`).bind(input.jobId).first<Record<string, unknown>>();
  if (!job) return { status: "failed", error: "岗位不存在" };
  const actor = await env.DB.prepare(`SELECT COALESCE(access_role,role) AS role, is_demo FROM users WHERE id = ?1 AND deleted = 0 AND disabled = 0`).bind(userId).first<{ role: string; is_demo: number }>();
  if (!actor || (job.user_id !== null ? job.user_id !== userId : !["admin", "super_admin"].includes(actor.role) || actor.is_demo === 1)) {
    return { status: "failed", error: "无权解析该岗位" };
  }

  const fingerprint = await fingerprintOf([job.id, job.job_version, job.jd_text]);
  if (fingerprint !== op.input_fingerprint) {
    return { status: "failed", error: "输入已过期（JD 已更新），请重新解析" };
  }

  try {
    const jdText = (job.jd_text as string) ?? "";
    if (!jdText.trim()) return { status: "failed", error: "岗位缺少 JD 原文，无法解析" };

    const provider = await getConfiguredAiProvider(env, userId, operationId);
    const raw = await provider.complete([
      { role: "system", content: "你是岗位要求抽取器。只输出 JSON。每个要求必须带 JD 原文引用 quote，禁止编造。" },
      { role: "user", content: JSON.stringify({ task: "parse_job_requirements", jdText }) },
    ]);

    let model: z.infer<typeof ModelRequirementsResponse>;
    try {
      model = ModelRequirementsResponse.parse(JSON.parse(raw));
    } catch {
      return { status: "failed", error: "模型响应格式错误，请重试" };
    }

    let rejected = 0;
    const candidates = model.requirements.filter((r) => {
      const ok = r.value && verifyQuote(jdText, r.quote).found;
      if (!ok) rejected++;
      return ok;
    });

    await env.DB.batch([
      env.DB
        .prepare(`UPDATE async_operations SET status = 'succeeded', result_json = ?1, updated_at = ?2 WHERE id = ?3`)
        .bind(JSON.stringify({ candidates, rejected }), nowIso(), operationId),
    ]);
    return { status: "succeeded" };
  } catch (e) {
    const message = e instanceof AiError ? e.message : e instanceof Error ? e.message : "解析失败";
    return { status: "failed", error: message };
  }
}
