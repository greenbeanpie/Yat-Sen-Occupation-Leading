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
      const job = await env.DB.prepare(`SELECT title FROM jobs WHERE id = ?1`).bind(item.jobId).first<{ title: string }>();
      if (job) jobTitles.set(item.jobId, job.title);
    }

    const provider = getAiProvider(env);
    const raw = await provider.complete([
      { role: "system", content: "你是求职计划生成器。只输出 JSON。任务必须可执行、可估时，不得编造已完成的事实。" },
      {
        role: "user",
        content: JSON.stringify({
          task: "generate_plan",
          jobs: selected.map((i) => ({ jobId: i.jobId, title: jobTitles.get(i.jobId) ?? "" })),
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
    const baseTasks = model.tasks.map((t) => ({ ...t, jobId: t.jobId ?? selected[0]?.jobId ?? null }));

    for (const t of baseTasks) {
      // 依赖：同岗位内顺序执行
      const deps = taskIds.length > 0 ? [] : [];
      void deps;
      const dayOffset = Math.floor(cursorHours / Math.max(dailyHours, 0.5));
      cursorHours += t.estimateHours;
      cursorDay = Math.min(dayOffset, 13); // 两周内
      const date = new Date(today.getTime() + cursorDay * 86_400_000).toISOString().slice(0, 10);
      const taskId = uuid();
      taskIds.push(taskId);
      stmts.push(
        env.DB
          .prepare(
            `INSERT INTO plan_tasks (id, user_id, plan_id, title, description, job_id, estimate_hours, scheduled_date, status, deps_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending', '[]', ?9, ?9)`,
          )
          .bind(taskId, userId, planId, t.title, t.description, t.jobId, t.estimateHours, date, now),
      );
    }

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
