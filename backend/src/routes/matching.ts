import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  AcceptedResponseSchema,
  CreateMatchSchema,
  ErrorBodySchema,
  MatchSnapshotSchema,
  PortfolioRequestSchema,
  PortfolioSchema,
  UuidSchema,
} from "../shared/schemas";
import { requireAuth } from "../middleware/auth";
import { notFound, syncRequired } from "../shared/errors";
import { startOperation } from "../application/operations";
import { assertFreshInputs, contextParts, contextFingerprint, loadRuleContext } from "../application/freshness";
import { selectPortfolio, type PortfolioCandidate } from "../domain/rules";
import { nowIso } from "../shared/datetime";
import type { AppEnv } from "../env";

type App = OpenAPIHono<AppEnv>;

const idParam = { name: "id", in: "params" as const, required: true, schema: UuidSchema };

const createMatch = createRoute({
  method: "post",
  path: "/matches",
  tags: ["matches"],
  middleware: [requireAuth] as const,
  request: { body: { content: { "application/json": { schema: CreateMatchSchema } }, required: true } },
  responses: {
    202: { content: { "application/json": { schema: AcceptedResponseSchema } }, description: "匹配分析作业已排队" },
    409: { content: { "application/json": { schema: ErrorBodySchema } }, description: "sync_required：存在未同步修改" },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
  },
});

const listMatches = createRoute({
  method: "get",
  path: "/matches",
  tags: ["matches"],
  middleware: [requireAuth] as const,
  request: { query: z.object({ jobId: UuidSchema }) },
  responses: {
    200: { content: { "application/json": { schema: z.object({ items: z.array(MatchSnapshotSchema) }) } }, description: "该岗位的匹配快照（最新在前）" },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
  },
});

const getMatch = createRoute({
  method: "get",
  path: "/matches/{id}",
  tags: ["matches"],
  middleware: [requireAuth] as const,
  request: { params: z.object({ id: UuidSchema }) },
  responses: {
    200: { content: { "application/json": { schema: MatchSnapshotSchema } }, description: "匹配解释（输入版本 + 引用列表）" },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
    404: { content: { "application/json": { schema: ErrorBodySchema } }, description: "不存在" },
  },
});

const createPortfolio = createRoute({
  method: "post",
  path: "/portfolios",
  tags: ["portfolios"],
  middleware: [requireAuth] as const,
  request: { body: { content: { "application/json": { schema: PortfolioRequestSchema } }, required: true } },
  responses: {
    201: { content: { "application/json": { schema: PortfolioSchema } }, description: "已生成求职组合" },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
  },
});

const listPortfolios = createRoute({
  method: "get",
  path: "/portfolios",
  tags: ["portfolios"],
  middleware: [requireAuth] as const,
  responses: {
    200: { content: { "application/json": { schema: z.object({ items: z.array(PortfolioSchema) }) } }, description: "我的组合列表" },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
  },
});

const getPortfolio = createRoute({
  method: "get",
  path: "/portfolios/{id}",
  tags: ["portfolios"],
  middleware: [requireAuth] as const,
  request: { params: z.object({ id: UuidSchema }) },
  responses: {
    200: { content: { "application/json": { schema: PortfolioSchema } }, description: "组合详情" },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
    404: { content: { "application/json": { schema: ErrorBodySchema } }, description: "不存在" },
  },
});

const updatePortfolio = createRoute({
  method: "put",
  path: "/portfolios/{id}",
  tags: ["portfolios"],
  middleware: [requireAuth] as const,
  request: {
    params: z.object({ id: UuidSchema }),
    body: { content: { "application/json": { schema: PortfolioRequestSchema } }, required: true },
  },
  responses: {
    200: { content: { "application/json": { schema: PortfolioSchema } }, description: "已重算（固定/移除/替换）" },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
    409: { content: { "application/json": { schema: ErrorBodySchema } }, description: "版本冲突" },
  },
});

/** 组合候选：用户已有就绪匹配快照的岗位。 */
async function loadCandidates(env: AppEnv["Bindings"], userId: string): Promise<PortfolioCandidate[]> {
  const rows = await env.DB
    .prepare(
      `SELECT ms.job_id, ms.scores_json, ms.hard_conditions_json, j.title, j.deadline_date,
        (SELECT COUNT(*) FROM plan_tasks pt WHERE pt.job_id = ms.job_id AND pt.user_id = ms.user_id AND pt.deleted = 0 AND pt.estimate_hours IS NOT NULL) AS has_tasks,
        (SELECT SUM(pt.estimate_hours) FROM plan_tasks pt WHERE pt.job_id = ms.job_id AND pt.user_id = ms.user_id AND pt.deleted = 0) AS prep_hours
       FROM match_snapshots ms
       JOIN jobs j ON j.id = ms.job_id
       WHERE ms.user_id = ?1 AND ms.status = 'ready'
         AND ms.id IN (SELECT MAX(id) FROM match_snapshots WHERE user_id = ?1 GROUP BY job_id)`,
    )
    .bind(userId)
    .all<Record<string, unknown>>();
  return rows.results.map((r) => {
    const conditions = JSON.parse((r.hard_conditions_json as string) ?? "[]") as { status: string }[];
    const hardBlocked = conditions.some((c) => c.status !== "met");
    return {
      jobId: r.job_id as string,
      title: (r.title as string) ?? "",
      score: (JSON.parse((r.scores_json as string) ?? "{}") as { total?: number }).total ?? 0,
      hardBlocked,
      prepHours: r.prep_hours != null ? Number(r.prep_hours) : null,
      deadline: (r.deadline_date as string | null) ?? null,
    };
  });
}

async function snapshotToJson(env: AppEnv["Bindings"], userId: string, row: Record<string, unknown>): Promise<Record<string, unknown>> {
  const ctx = await loadRuleContext(env, userId);
  const job = await env.DB.prepare(`SELECT job_version FROM jobs WHERE id = ?1`).bind(row.job_id as string).first<{ job_version: number }>();
  const currentFingerprint = await contextFingerprint(ctx, [row.job_id, job?.job_version ?? 0]);
  const stale = currentFingerprint !== row.input_fingerprint;
  return {
    id: row.id,
    jobId: row.job_id,
    operationId: row.operation_id ?? null,
    ruleVersion: row.rule_version,
    inputVersions: JSON.parse((row.input_versions as string) ?? "{}"),
    hardConditions: JSON.parse((row.hard_conditions_json as string) ?? "[]"),
    scores: JSON.parse((row.scores_json as string) ?? "{}"),
    gaps: JSON.parse((row.gaps_json as string) ?? "[]"),
    explanation: JSON.parse((row.explanation_json as string) ?? "{}"),
    quotes: JSON.parse((row.quotes_json as string) ?? "[]"),
    status: stale ? "stale" : row.status,
    error: row.error ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: Number(row.version),
  };
}

export function registerMatchingRoutes(app: App): void {
  app.openapi(createMatch, async (c) => {
    const userId = c.get("user").id;
    const body = c.req.valid("json");
    await assertFreshInputs(c.env, userId, body.clientProfileVersion, body.clientExperienceVersions);
    const jobRow = await c.env.DB.prepare(`SELECT id, job_version FROM jobs WHERE id = ?1 AND deleted = 0`).bind(body.jobId).first<{ job_version: number }>();
    if (!jobRow) throw notFound("岗位不存在");
    const ctx = await loadRuleContext(c.env, userId);
    const operationId = await startOperation(
      c.env,
      userId,
      "generate_match",
      { jobId: body.jobId },
      contextParts(ctx, [body.jobId, jobRow.job_version]),
    );
    return c.json({ operationId }, 202 as const) as never;
  });

  app.openapi(listMatches, async (c) => {
    const userId = c.get("user").id;
    const { jobId } = c.req.valid("query");
    const rows = await c.env.DB
      .prepare(`SELECT * FROM match_snapshots WHERE user_id = ?1 AND job_id = ?2 AND status != 'failed' ORDER BY created_at DESC LIMIT 20`)
      .bind(userId, jobId)
      .all<Record<string, unknown>>();
    const items = await Promise.all(rows.results.map((r) => snapshotToJson(c.env, userId, r)));
    return c.json({ items }, 200 as const) as never;
  });

  app.openapi(getMatch, async (c) => {
    const userId = c.get("user").id;
    const { id } = c.req.valid("param");
    const row = await c.env.DB.prepare(`SELECT * FROM match_snapshots WHERE id = ?1 AND user_id = ?2`).bind(id, userId).first<Record<string, unknown>>();
    if (!row) throw notFound();
    return c.json((await snapshotToJson(c.env, userId, row)) as never, 200 as const);
  });

  app.openapi(createPortfolio, async (c) => {
    const userId = c.get("user").id;
    const body = c.req.valid("json");
    const result = await computeAndStore(c.env, userId, body.timeBudgetHours, body.pinnedJobIds ?? [], body.removedJobIds ?? [], body.asOfDate ?? null);
    return c.json(result as never, 201 as const);
  });

  app.openapi(listPortfolios, async (c) => {
    const userId = c.get("user").id;
    const rows = await c.env.DB.prepare(`SELECT * FROM portfolios WHERE user_id = ?1 AND deleted = 0 ORDER BY created_at DESC`).bind(userId).all<Record<string, unknown>>();
    return c.json({ items: rows.results.map(portfolioToJson) }, 200 as const) as never;
  });

  app.openapi(getPortfolio, async (c) => {
    const userId = c.get("user").id;
    const { id } = c.req.valid("param");
    const row = await c.env.DB.prepare(`SELECT * FROM portfolios WHERE id = ?1 AND user_id = ?2 AND deleted = 0`).bind(id, userId).first<Record<string, unknown>>();
    if (!row) throw notFound();
    return c.json(portfolioToJson(row) as never, 200 as const);
  });

  app.openapi(updatePortfolio, async (c) => {
    const userId = c.get("user").id;
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const row = await c.env.DB.prepare(`SELECT * FROM portfolios WHERE id = ?1 AND user_id = ?2 AND deleted = 0`).bind(id, userId).first<Record<string, unknown>>();
    if (!row) throw notFound();
    // PUT 语义：携带完整的期望状态（pinnedJobIds / removedJobIds 为全量列表）
    const result = await computeAndStore(c.env, userId, body.timeBudgetHours, body.pinnedJobIds ?? [], body.removedJobIds ?? [], body.asOfDate ?? null, id, Number(row.version) + 1);
    return c.json(result as never, 200 as const) as never;
  });
}

async function computeAndStore(
  env: AppEnv["Bindings"],
  userId: string,
  budgetHours: number,
  pinned: string[],
  removed: string[],
  asOfDate: string | null,
  existingId?: string,
  existingVersion?: number,
): Promise<Record<string, unknown>> {
  const candidates = await loadCandidates(env, userId);
  const profileRow = await env.DB.prepare(`SELECT weekly_time_budget_hours FROM profiles WHERE user_id = ?1`).bind(userId).first<{ weekly_time_budget_hours: number | null }>();
  const today = asOfDate ?? nowIso().slice(0, 10);
  const selection = selectPortfolio(candidates, budgetHours, pinned, removed, (profileRow?.weekly_time_budget_hours ?? null) as number | null, today);

  const itemsJson = JSON.stringify(selection.items);
  const notesJson = JSON.stringify(selection.notes);
  const id = existingId ?? crypto.randomUUID();
  const now = nowIso();
  if (existingId) {
    await env.DB
      .prepare(`UPDATE portfolios SET time_budget_hours = ?2, items_json = ?3, notes_json = ?4, version = ?5, updated_at = ?6 WHERE id = ?1`)
      .bind(id, budgetHours, itemsJson, notesJson, existingVersion ?? 1, now)
      .run();
  } else {
    await env.DB
      .prepare(`INSERT INTO portfolios (id, user_id, time_budget_hours, items_json, notes_json, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`)
      .bind(id, userId, budgetHours, itemsJson, notesJson, now)
      .run();
  }
  return {
    id,
    userId,
    version: existingVersion ?? 1,
    deleted: false,
    createdAt: now,
    updatedAt: now,
    timeBudgetHours: budgetHours,
    items: selection.items,
    notes: selection.notes,
  };
}

function portfolioToJson(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    userId: row.user_id,
    version: Number(row.version),
    deleted: Number(row.deleted) === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    timeBudgetHours: row.time_budget_hours,
    items: JSON.parse((row.items_json as string) ?? "[]"),
    notes: JSON.parse((row.notes_json as string) ?? "{}"),
  };
}
