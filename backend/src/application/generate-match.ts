import { getConfiguredAiProvider } from '../infra/ai/settings';
import { z } from "zod";
import type { Env } from "../env";
import { AiError } from "../infra/ai";
import { verifyQuote } from "../domain/quotes";
import { computeMatchScores, evaluateHardConditions, type HardRequirement } from "../domain/rules";
import { nowIso, uuid } from "../shared/datetime";
import type { ProcessorResult } from "./processors";
import { contextFingerprint, loadRuleContext } from "./freshness";

/** 模型解释响应的自身校验。 */
const ModelMatchResponse = z.object({
  summary: z.string().max(2000).default(""),
  advantages: z
    .array(z.object({ text: z.string().max(500), quotes: z.array(z.string().max(500)).max(5).default([]) }))
    .max(10)
    .default([]),
  gaps: z
    .array(z.object({ text: z.string().max(500), quotes: z.array(z.string().max(500)).max(5).default([]) }))
    .max(10)
    .default([]),
  prepSuggestions: z
    .array(z.object({ text: z.string().max(500), quotes: z.array(z.string().max(500)).max(5).default([]) }))
    .max(10)
    .default([]),
});

function verifyQuoteGroup<T extends { text: string; quotes: string[] }>(
  items: T[],
  source: string,
): { kept: { text: string; quotes: { text: string; location: string | null }[] }[]; dropped: number } {
  let dropped = 0;
  const kept = [];
  for (const item of items) {
    const okQuotes: { text: string; location: string | null }[] = [];
    for (const q of item.quotes) {
      const hit = verifyQuote(source, q);
      if (hit.found) okQuotes.push({ text: q, location: `${hit.start}-${hit.end}` });
      else dropped++;
    }
    // 文字断言本身可保留，但未命中引用的断言不带引用
    kept.push({ text: item.text, quotes: okQuotes });
  }
  return { kept, dropped };
}

/**
 * 匹配解释（backend_plan.md 7.3/7.6）：规则引擎产出硬条件/分数（确定性），
 * 模型只产出解释文字；解释中的引用必须在 JD 原文中命中，伪造引用直接拒绝该条引用。
 * 结果带输入版本集与引用列表；读取时按指纹判断是否过期。
 */
export async function processGenerateMatch(env: Env, operationId: string): Promise<ProcessorResult> {
  const op = await env.DB.prepare(`SELECT * FROM async_operations WHERE id = ?1`).bind(operationId).first<Record<string, unknown>>();
  if (!op) return { status: "failed", error: "作业不存在" };
  if (op.status === "succeeded") return { status: "succeeded" };

  const userId = op.user_id as string;
  const input = JSON.parse(op.input_json as string) as { jobId: string };
  const job = await env.DB
    .prepare(`SELECT * FROM jobs WHERE id = ?1 AND deleted = 0 AND ((user_id IS NULL AND status = 'published') OR user_id = ?2)`)
    .bind(input.jobId, userId)
    .first<Record<string, unknown>>();
  if (!job) return { status: "failed", error: "岗位不存在或未发布" };

  const ctx = await loadRuleContext(env, userId);
  const fingerprint = await contextFingerprint(ctx, [job.id, job.job_version]);
  if (fingerprint !== op.input_fingerprint) {
    return { status: "failed", error: "输入已过期（画像或岗位已变化），请重新发起分析" };
  }

  try {
    const reqRows = await env.DB
      .prepare(`SELECT kind, value, quote FROM job_requirements WHERE job_id = ?1 AND job_version = ?2`)
      .bind(job.id, job.job_version)
      .all<{ kind: string; value: string; quote: string | null }>();
    const requirements: HardRequirement[] = reqRows.results.map((r) => ({ kind: r.kind, value: r.value, quote: r.quote }));

    const hardConditions = evaluateHardConditions(requirements, ctx.profile, ctx.evidence);
    const scores = computeMatchScores(requirements, ctx.evidence, ctx.profile, {
      title: job.title as string,
      company: (job.company as string) ?? "",
      location: (job.location as string | null) ?? null,
    });
    const gaps = hardConditions
      .filter((c) => c.status !== "met")
      .map((c) => `${c.kind}: ${c.requirement}${c.note ? `（${c.note}）` : ""}`);

    const jdText = (job.jd_text as string) ?? "";
    const provider = await getConfiguredAiProvider(env, userId, operationId);
    const raw = await provider.complete([
      { role: "system", content: "你是求职匹配解释器。只输出 JSON。所有 quotes 必须来自给定 JD 原文，禁止编造。不预测录取概率。" },
      {
        role: "user",
        content: JSON.stringify({
          task: "generate_match",
          jdText,
          requirements: requirements.map((r) => ({ kind: r.kind, value: r.value })),
          scores: { total: scores.total },
          gaps,
        }),
      },
    ]);

    let model: z.infer<typeof ModelMatchResponse>;
    try {
      model = ModelMatchResponse.parse(JSON.parse(raw));
    } catch {
      return { status: "failed", error: "模型响应格式错误，请重试" };
    }

    const adv = verifyQuoteGroup(model.advantages, jdText);
    const gap = verifyQuoteGroup(model.gaps, jdText);
    const prep = verifyQuoteGroup(model.prepSuggestions, jdText);
    const quotes = [...adv.kept, ...gap.kept, ...prep.kept].flatMap((g) => g.quotes.map((q) => ({ text: q.text, source: "jd", location: q.location })));

    const snapshotId = uuid();
    await env.DB.batch([
      env.DB
        .prepare(
          `INSERT INTO match_snapshots (id, user_id, job_id, operation_id, rule_version, input_versions, input_fingerprint,
           hard_conditions_json, scores_json, gaps_json, explanation_json, quotes_json, status, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'ready', ?13, ?13)`,
        )
        .bind(
          snapshotId,
          userId,
          job.id,
          operationId,
          "rules-v1",
          JSON.stringify({ profileVersion: ctx.profileVersion, experiences: ctx.experiences.map((e) => ({ id: e.id, version: e.version })) }),
          fingerprint,
          JSON.stringify(hardConditions),
          JSON.stringify(scores),
          JSON.stringify(gaps),
          JSON.stringify({
            summary: model.summary,
            advantages: adv.kept,
            gaps: gap.kept,
            prepSuggestions: prep.kept,
            rejectedQuotes: adv.dropped + gap.dropped + prep.dropped,
          }),
          JSON.stringify(quotes),
          nowIso(),
        ),
      env.DB.prepare(`UPDATE async_operations SET status = 'succeeded', result_ref = ?1, updated_at = ?2 WHERE id = ?3`).bind(
        snapshotId,
        nowIso(),
        operationId,
      ),
    ]);
    return { status: "succeeded" };
  } catch (e) {
    const message = e instanceof AiError ? e.message : e instanceof Error ? e.message : "匹配分析失败";
    return { status: "failed", error: message };
  }
}
