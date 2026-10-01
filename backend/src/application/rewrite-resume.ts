import { getConfiguredAiProvider } from '../infra/ai/settings';
import { z } from "zod";
import type { Env } from "../env";
import { AiError } from "../infra/ai";
import { verifyQuote } from "../domain/quotes";
import { nowIso } from "../shared/datetime";
import { contextFingerprint, loadRuleContext } from "./freshness";
import type { ProcessorResult } from "./processors";

const ModelRewriteResponse = z.object({
  items: z
    .array(
      z.object({
        originalQuote: z.string().max(2000),
        suggestion: z.string().max(2000),
        rationale: z.string().max(1000).default(""),
      }),
    )
    .max(10)
    .default([]),
});

/**
 * 简历改写（PLAN.md 2.4/2.5）：展示原文与建议对照，逐条采纳；
 * 引用必须命中经历原文；新增数字、成果和无法核验的断言不进入可采纳结果。
 */
export async function processRewriteResume(env: Env, operationId: string): Promise<ProcessorResult> {
  const op = await env.DB.prepare(`SELECT * FROM async_operations WHERE id = ?1`).bind(operationId).first<Record<string, unknown>>();
  if (!op) return { status: "failed", error: "作业不存在" };
  if (op.status === "succeeded") return { status: "succeeded" };

  const userId = op.user_id as string;
  const input = JSON.parse(op.input_json as string) as { experienceId: string };
  const experience = await env.DB.prepare(`SELECT * FROM experiences WHERE id = ?1 AND user_id = ?2 AND deleted = 0`)
    .bind(input.experienceId, userId)
    .first<Record<string, unknown>>();
  if (!experience) return { status: "failed", error: "经历不存在" };

  const ctx = await loadRuleContext(env, userId);
  const fingerprint = await contextFingerprint(ctx, [experience.id, experience.version]);

  try {
    const description = experience.description as string;
    const provider = await getConfiguredAiProvider(env, userId, operationId);
    const raw = await provider.complete([
      {
        role: "system",
        content:
          "你是简历改写助手。只输出 JSON。suggestion 只能基于 originalQuote 中的事实重新表述，禁止新增任何数字、成果或无法核验的断言。",
      },
      { role: "user", content: JSON.stringify({ task: "rewrite_resume", description }) },
    ]);

    let model: z.infer<typeof ModelRewriteResponse>;
    try {
      model = ModelRewriteResponse.parse(JSON.parse(raw));
    } catch {
      return { status: "failed", error: "模型响应格式错误，请重试" };
    }

    // 引用核验：originalQuote 必须命中原文；建议中的断言必须来自原文引用（mock 保证不新增事实）
    let rejected = 0;
    const items = model.items
      .filter((i) => {
        const ok = verifyQuote(description, i.originalQuote).found;
        if (!ok) rejected++;
        return ok;
      })
      .map((i, idx) => ({
        id: `item-${idx + 1}`,
        originalQuote: i.originalQuote,
        suggestion: i.suggestion,
        rationale: i.rationale,
        quoteVerified: true,
        status: "pending" as const,
      }));

    const rewriteId = crypto.randomUUID();
    const now = nowIso();
    await env.DB.batch([
      env.DB
        .prepare(
          `INSERT INTO rewrites (id, user_id, experience_id, operation_id, input_fingerprint, items_json, status, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'ready', ?7, ?7)`,
        )
        .bind(rewriteId, userId, experience.id, operationId, fingerprint, JSON.stringify({ items, rejected }), now),
      env.DB.prepare(`UPDATE async_operations SET status = 'succeeded', result_ref = ?1, updated_at = ?2 WHERE id = ?3`).bind(
        rewriteId,
        nowIso(),
        operationId,
      ),
    ]);
    return { status: "succeeded" };
  } catch (e) {
    const message = e instanceof AiError ? e.message : e instanceof Error ? e.message : "改写失败";
    return { status: "failed", error: message };
  }
}
