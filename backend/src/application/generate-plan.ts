import { visibleJob } from "./access";
import { z } from "zod";
import type { Env } from "../env";
import { getAiProvider, AiError } from "../infra/ai";
import { nowIso, uuid } from "../shared/datetime";
import { RULE_VERSION } from "../shared/constants";
import { contextFingerprint, loadRuleContext } from "./freshness";
import type { ProcessorResult } from "./processors";

const ModelPlanResponse = z.object({
  tasks: z
    .array(
      z.object({
        title: z.string().max(200),
        description: z.string().max(2000).default(""),
        estimateHours: z.number().positive().max(100).default(2),
        jobId: z.string().nullish(),
        /** 该任务应对的岗位差距，必须取自提示中给出的候选差距。 */
        gap: z.string().max(500).nullish(),
        /** 已确认证据关联（experience_skills.id）。 */
        evidenceId: z.string().nullish(),
        /** 依赖的任务序号（仅允许引用前面的任务，天然避免环）。 */
        dependsOn: z.array(z.number().int().nonnegative()).max(10).default([]),
      }),
    )
    .max(30)
    .default([]),
});

/**
 * 两周计划生成（PLAN.md 2.5）：基于组合中的已选岗位生成任务与排期；
 * 学生确认后才生效（draft → confirmed）。生成与采纳是两个独立动作。
 */
export async function processGeneratePlan(env: Env, operationId: string): Promise<ProcessorResult> {
  const op = await env.DB.prepare(`SELECT * FROM async_operations WHERE id = ?1`).bind(operationId).first<Record<string, unknown>>();
  if (!op) return { status: "failed", error: "作业不存在" };
  if (op.status === "succeeded") return { status: "succeeded" };

  const userId = op.user_id as string;
  const input = JSON.parse(op.input_json as string) as { portfolioId: string };
  const portfolio = await env.DB.prepare(`SELECT * FROM portfolios WHERE id = ?1 AND user_id = ?2 AND deleted = 0`)
    .bind(input.portfolioId, userId)
    .first<Record<string, unknown>>();
  if (!portfolio) return { status: "failed", error: "组合不存在" };

  const ctx = await loadRuleContext(env, userId);
  const fingerprint = await contextFingerprint(ctx, [portfolio.id, portfolio.version]);

  try {
    const items = JSON.parse((portfolio.items_json as string) ?? "[]") as { jobId: string; selected: boolean; score: number }[];
    const selected = items.filter((i) => i.selected);
    if (selected.length === 0) return { status: "failed", error: "组合中没有已选岗位，无法生成计划" };

    const jobTitles = new Map<string, string>();
    for (const item of selected) {
      const job = await visibleJob(env, userId, item.jobId);
      jobTitles.set(item.jobId, job.title as string);
    }

    // 计划任务要能关联具体岗位、差距或已确认证据（PLAN.md 2.5），
    // 因此把规则引擎算出的差距与用户已确认的证据一并交给模型，并在写入前逐一校验。
    const selectedIds = new Set(selected.map((item) => item.jobId));
    const gapsByJob = new Map<string, string[]>();
    for (const item of selected) {
      const snapshot = await env.DB
        .prepare(
          `SELECT gaps_json FROM match_snapshots
            WHERE user_id = ?1 AND job_id = ?2 AND status = 'ready'
            ORDER BY created_at DESC LIMIT 1`,
        )
        .bind(userId, item.jobId)
        .first<{ gaps_json: string }>();
      const raw = snapshot ? (JSON.parse(snapshot.gaps_json) as unknown[]) : [];
      gapsByJob.set(
        item.jobId,
        raw.filter((value): value is string => typeof value === "string" && value.length > 0).slice(0, 8),
      );
    }

    const evidenceRows = await env.DB
      .prepare(
        `SELECT es.id, s.name AS skill_name, e.title AS experience_title
           FROM experience_skills es
           JOIN skills s ON s.id = es.skill_id
           JOIN experiences e ON e.id = es.experience_id
          WHERE es.user_id = ?1 AND es.deleted = 0 AND es.status = 'confirmed'
            AND s.deleted = 0 AND e.deleted = 0
          ORDER BY es.created_at DESC LIMIT 20`,
      )
      .bind(userId)
      .all<{ id: string; skill_name: string; experience_title: string }>();
    const evidence = evidenceRows.results.map((row) => ({
      evidenceId: row.id,
      skill: row.skill_name,
      experience: row.experience_title,
    }));
    const allowedEvidenceIds = new Set(evidence.map((row) => row.evidenceId));

    const provider = getAiProvider(env);
    const raw = await provider.complete([
      { role: "system", content: "你是求职计划生成器。只输出 JSON。任务必须可执行、可估时，不得编造已完成的事实。" },
      {
        role: "user",
        content: JSON.stringify({
          task: "generate_plan",
          jobs: selected.map((i) => ({
            jobId: i.jobId,
            title: jobTitles.get(i.jobId) ?? "",
            gaps: gapsByJob.get(i.jobId) ?? [],
          })),
          evidence,
          rules: {
            gap: "gap 必须逐字取自对应岗位的 gaps；没有合适的差距时留空，不要编造。",
            evidenceId: "evidenceId 只能取 evidence 里的 evidenceId；没有对应证据时留空。",
            dependsOn: "dependsOn 只能引用同一响应中序号更小的任务。",
          },
        }),
      },
    ]);

    let model: z.infer<typeof ModelPlanResponse>;
    try {
      model = ModelPlanResponse.parse(JSON.parse(raw));
    } catch {
      return { status: "failed", error: "模型响应格式错误，请重试" };
    }

    // 排期：两周内按每周时间预算分布任务日期
    const weekly = (ctx.profile as unknown as { weeklyTimeBudgetHours?: number }).weeklyTimeBudgetHours ?? 8;
    const dailyHours = weekly / 7;
    const today = new Date(nowIso().slice(0, 10));
    const planId = uuid();
    const now = nowIso();
    let cursorHours = 0;
    let cursorDay = 0;
    const stmts: D1PreparedStatement[] = [];
    const taskIds: string[] = [];
    // 只有单一已选岗位时才回填岗位，多岗位时宁可为空，也不把任务错误地挂到第一个岗位。
    const fallbackJobId = selected.length === 1 ? selected[0]!.jobId : null;

    model.tasks.forEach((t, index) => {
      const jobId = t.jobId && selectedIds.has(t.jobId) ? t.jobId : fallbackJobId;
      const allowedGaps = jobId ? gapsByJob.get(jobId) ?? [] : [];
      const gap = t.gap && allowedGaps.includes(t.gap) ? t.gap : null;
      const evidenceId = t.evidenceId && allowedEvidenceIds.has(t.evidenceId) ? t.evidenceId : null;
      const deps = [...new Set(t.dependsOn.filter((dep) => dep < index))].map((dep) => taskIds[dep]!).filter(Boolean);
      const dayOffset = Math.floor(cursorHours / Math.max(dailyHours, 0.5));
      cursorHours += t.estimateHours;
      cursorDay = Math.min(dayOffset, 13); // 两周内
      const date = new Date(today.getTime() + cursorDay * 86_400_000).toISOString().slice(0, 10);
      const taskId = uuid();
      taskIds.push(taskId);
      stmts.push(
        env.DB
          .prepare(
            `INSERT INTO plan_tasks (id, user_id, plan_id, title, description, job_id, evidence_id, gap, estimate_hours, scheduled_date, status, deps_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'pending', ?11, ?12, ?12)`,
          )
          .bind(
            taskId,
            userId,
            planId,
            t.title,
            t.description,
            jobId,
            evidenceId,
            gap,
            t.estimateHours,
            date,
            JSON.stringify(deps),
            now,
          ),
      );
    });

    stmts.push(
      env.DB
        .prepare(
          `INSERT INTO plans (id, user_id, portfolio_id, status, operation_id, rule_version, input_fingerprint, created_at, updated_at)
           VALUES (?1, ?2, ?3, 'draft', ?4, ?5, ?6, ?7, ?7)`,
        )
        .bind(planId, userId, portfolio.id, operationId, RULE_VERSION, fingerprint, now),
      env.DB.prepare(`UPDATE async_operations SET status = 'succeeded', result_ref = ?1, updated_at = ?2 WHERE id = ?3`).bind(
        planId,
        nowIso(),
        operationId,
      ),
    );
    await env.DB.batch(stmts);
    return { status: "succeeded" };
  } catch (e) {
    const message = e instanceof AiError ? e.message : e instanceof Error ? e.message : "计划生成失败";
    return { status: "failed", error: message };
  }
}
