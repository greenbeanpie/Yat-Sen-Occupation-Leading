import { pageRows } from "../infra/pagination";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  AcceptedResponseSchema,
  ErrorBodySchema,
  JobListResponseSchema,
  JobListQuerySchema,
  JobPayloadSchema,
  JobPublishSchema,
  JobRequirementsDraftSchema,
  JobSchema,
  UuidSchema,
} from "../shared/schemas";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { forbidden, notFound, conflict } from "../shared/errors";
import { rowToJson } from "../application/entity-writer";
import { startOperation } from "../application/operations";
import { nowIso, uuid } from "../shared/datetime";
import type { AppEnv } from "../env";

type App = OpenAPIHono<AppEnv>;

const JOB_FIELDS = {
  title: {},
  company: {},
  location: { nullable: true },
  degreeRequirement: { nullable: true },
  graduationYearFrom: { nullable: true },
  graduationYearTo: { nullable: true },
  sourceUrl: { nullable: true },
  deadlineDate: { nullable: true },
  status: {},
  jdText: {},
} as const;

export function jobToJson(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...rowToJson({ entity: "job", table: "jobs", fields: JOB_FIELDS }, row),
    userId: row.user_id ?? null,
    scope: row.user_id ? "private" : "public",
    jobVersion: Number(row.job_version),
    requirements: [], // 由查询方按需填充
  };
}

export function jobVersionSnapshot(db: D1Database, jobId: string, jobVersion: number, jdText: string, requirements: unknown[]): D1PreparedStatement {
  return db
    .prepare(`INSERT INTO job_versions (id, job_id, version, jd_text, requirements_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`)
    .bind(uuid(), jobId, jobVersion, jdText, JSON.stringify(requirements), nowIso());
}

function canEditJob(row: Record<string, unknown>, userId: string, role: string): boolean {
  if (row.user_id === null || row.user_id === undefined) return ["admin", "super_admin"].includes(role);
  return row.user_id === userId;
}

const listJobs = createRoute({
  method: "get",
  path: "/jobs",
  tags: ["jobs"],
  middleware: [requireAuth] as const,
  request: { query: JobListQuerySchema },
  responses: {
    200: { content: { "application/json": { schema: JobListResponseSchema } }, description: "公共（已发布）与私人岗位查询" },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
  },
});

const createJob = createRoute({
  method: "post",
  path: "/jobs",
  tags: ["jobs"],
  middleware: [requireAuth] as const,
  request: { body: { content: { "application/json": { schema: JobPayloadSchema } }, required: true } },
  responses: {
    201: { content: { "application/json": { schema: JobSchema } }, description: "私人岗位已创建（草稿）" },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
  },
});

const getJob = createRoute({
  method: "get",
  path: "/jobs/{id}",
  tags: ["jobs"],
  middleware: [requireAuth] as const,
  request: { params: z.object({ id: UuidSchema }) },
  responses: {
    200: { content: { "application/json": { schema: JobSchema } }, description: "岗位详情（含当前版本硬条件）" },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
    404: { content: { "application/json": { schema: ErrorBodySchema } }, description: "不存在或未发布" },
  },
});

const updateJob = createRoute({
  method: "put",
  path: "/jobs/{id}",
  tags: ["jobs"],
  middleware: [requireAuth] as const,
  request: {
    params: z.object({ id: UuidSchema }),
    body: { content: { "application/json": { schema: JobPayloadSchema.extend({ baseVersion: z.number().int() }) } }, required: true },
  },
  responses: {
    200: { content: { "application/json": { schema: JobSchema } }, description: "已保存（JD 变化会生成新版本并清空要求）" },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
    403: { content: { "application/json": { schema: ErrorBodySchema } }, description: "无权修改" },
    409: { content: { "application/json": { schema: ErrorBodySchema } }, description: "版本冲突" },
  },
});

const deleteJob = createRoute({
  method: "delete",
  path: "/jobs/{id}",
  tags: ["jobs"],
  middleware: [requireAuth] as const,
  request: { params: z.object({ id: UuidSchema }) },
  responses: {
    204: { description: "已删除（墓碑）" },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
    403: { content: { "application/json": { schema: ErrorBodySchema } }, description: "无权删除" },
  },
});

const parseRequirements = createRoute({
  method: "post",
  path: "/jobs/{id}/parse-requirements",
  tags: ["jobs"],
  middleware: [requireAuth] as const,
  request: { params: z.object({ id: UuidSchema }) },
  responses: {
    202: { content: { "application/json": { schema: AcceptedResponseSchema } }, description: "要求解析作业已排队" },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
    404: { content: { "application/json": { schema: ErrorBodySchema } }, description: "不存在" },
  },
});

const getRequirementsDraft = createRoute({
  method: "get",
  path: "/jobs/{id}/requirements-draft",
  tags: ["jobs"],
  middleware: [requireAuth] as const,
  request: { params: z.object({ id: UuidSchema }) },
  responses: {
    200: { content: { "application/json": { schema: JobRequirementsDraftSchema } }, description: "要求解析草稿（确认后才写入岗位）" },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
    404: { content: { "application/json": { schema: ErrorBodySchema } }, description: "尚无就绪草稿" },
  },
});

const confirmRequirements = createRoute({
  method: "post",
  path: "/jobs/{id}/requirements/confirm",
  tags: ["jobs"],
  middleware: [requireAuth] as const,
  request: { params: z.object({ id: UuidSchema }) },
  responses: {
    200: { content: { "application/json": { schema: z.object({ count: z.number() }) } }, description: "要求已确认写入当前 JD 版本" },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
    404: { content: { "application/json": { schema: ErrorBodySchema } }, description: "尚无就绪草稿" },
  },
});

export function registerJobRoutes(app: App): void {
  app.openapi(listJobs, async (c) => {
    const userId = c.get("user").id;
    const role = c.get("user").demo ? "student" : c.get("user").role;
    const query = c.req.valid("query");
    const scope = query.scope ?? "public";
    const conditions: string[] = [];
    const binds: (string | number)[] = [];
    if (scope === "mine") {
      conditions.push(`user_id = ?${binds.length + 1}`);
      binds.push(userId);
    } else {
      if (["admin", "super_admin"].includes(role)) {
        conditions.push(`user_id IS NULL`);
      } else {
        conditions.push(`user_id IS NULL AND status = 'published'`);
      }
    }
    if (query.q) {
      conditions.push(`(title LIKE ?${binds.length + 1} OR jd_text LIKE ?${binds.length + 1})`);
      binds.push(`%${query.q}%`);
    }
    if (query.degree) {
      conditions.push(`degree_requirement = ?${binds.length + 1}`);
      binds.push(query.degree);
    }
    if (query.location) {
      conditions.push(`location LIKE ?${binds.length + 1}`);
      binds.push(`%${query.location}%`);
    }
    const rows = await pageRows(c, `SELECT * FROM jobs WHERE deleted = 0 AND ${conditions.join(" AND ")} ORDER BY created_at DESC, id DESC`, [...binds]);
    return c.json({ items: rows.results.map(jobToJson), nextCursor: rows.nextCursor }, 200 as const) as never;
  });

  app.openapi(createJob, async (c) => {
    const userId = c.get("user").id;
    const payload = c.req.valid("json");
    const id = uuid();
    const now = nowIso();
    const record = {
      id,
      userId,
      scope: "private" as const,
      version: 1,
      deleted: false,
      createdAt: now,
      updatedAt: now,
      title: payload.title,
      company: payload.company ?? "",
      location: payload.location ?? null,
      degreeRequirement: payload.degreeRequirement ?? null,
      graduationYearFrom: payload.graduationYearFrom ?? null,
      graduationYearTo: payload.graduationYearTo ?? null,
      sourceUrl: payload.sourceUrl ?? null,
      deadlineDate: payload.deadlineDate ?? null,
      status: "draft" as const,
      jdText: payload.jdText ?? "",
      jobVersion: 1,
      requirements: [],
    };
    await c.env.DB.batch([
      c.env.DB
        .prepare(
          `INSERT INTO jobs (id, user_id, title, company, location, degree_requirement, graduation_year_from, graduation_year_to, source_url, deadline_date, status, jd_text, job_version, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'draft', ?11, 1, ?12, ?12)`,
        )
        .bind(
          id,
          userId,
          payload.title,
          payload.company ?? "",
          payload.location ?? null,
          payload.degreeRequirement ?? null,
          payload.graduationYearFrom ?? null,
          payload.graduationYearTo ?? null,
          payload.sourceUrl ?? null,
          payload.deadlineDate ?? null,
          payload.jdText ?? "",
          now,
        ),
      jobVersionSnapshot(c.env.DB, id, 1, payload.jdText ?? "", []),
    ]);
    return c.json(record as never, 201 as const);
  });

  app.openapi(getJob, async (c) => {
    const userId = c.get("user").id;
    const role = c.get("user").demo ? "student" : c.get("user").role;
    const { id } = c.req.valid("param");
    const row = await c.env.DB.prepare(`SELECT * FROM jobs WHERE id = ?1 AND deleted = 0`).bind(id).first<Record<string, unknown>>();
    if (!row) throw notFound();
    const visible = row.user_id !== null && row.user_id === userId ? true : row.user_id === null && (row.status === "published" || ["admin", "super_admin"].includes(role));
    if (!visible) throw notFound();
    const reqRows = await c.env.DB
      .prepare(`SELECT kind, value, quote FROM job_requirements WHERE job_id = ?1 AND job_version = ?2`)
      .bind(id, row.job_version)
      .all<{ kind: string; value: string; quote: string | null }>();
    return c.json({ ...jobToJson(row), requirements: reqRows.results } as never, 200 as const);
  });

  app.openapi(updateJob, async (c) => {
    const userId = c.get("user").id;
    const role = c.get("user").demo ? "student" : c.get("user").role;
    const { id } = c.req.valid("param");
    const { baseVersion, ...payload } = c.req.valid("json");
    const row = await c.env.DB.prepare(`SELECT * FROM jobs WHERE id = ?1 AND deleted = 0`).bind(id).first<Record<string, unknown>>();
    if (!row) throw notFound();
    if (!canEditJob(row, userId, role)) throw forbidden("只能修改自己的私人岗位");
    if (baseVersion !== Number(row.version)) throw conflict("岗位已被其他修改更新", jobToJson(row));

    const jdChanged = payload.jdText !== undefined && payload.jdText !== row.jd_text;
    const newJobVersion = jdChanged ? Number(row.job_version) + 1 : Number(row.job_version);
    const now = nowIso();
    const stmts = [
      c.env.DB
        .prepare(
          `UPDATE jobs SET title = ?2, company = ?3, location = ?4, degree_requirement = ?5, graduation_year_from = ?6, graduation_year_to = ?7,
           source_url = ?8, deadline_date = ?9, jd_text = ?10, job_version = ?11, version = ?12, updated_at = ?13
           WHERE id = ?1`,
        )
        .bind(
          id,
          payload.title ?? (row.title as string),
          payload.company ?? (row.company as string),
          payload.location ?? row.location,
          payload.degreeRequirement ?? row.degree_requirement,
          payload.graduationYearFrom ?? row.graduation_year_from,
          payload.graduationYearTo ?? row.graduation_year_to,
          payload.sourceUrl === undefined ? row.source_url : payload.sourceUrl,
          payload.deadlineDate ?? row.deadline_date,
          payload.jdText ?? (row.jd_text as string),
          newJobVersion,
          Number(row.version) + 1,
          now,
        ),
    ];
    if (jdChanged) {
      stmts.push(jobVersionSnapshot(c.env.DB, id, newJobVersion, payload.jdText ?? "", []));
      stmts.push(c.env.DB.prepare(`DELETE FROM job_requirements WHERE job_id = ?1 AND job_version >= ?2`).bind(id, newJobVersion));
    }
    await c.env.DB.batch(stmts);
    const updated = await c.env.DB.prepare(`SELECT * FROM jobs WHERE id = ?1`).bind(id).first<Record<string, unknown>>();
    return c.json(jobToJson(updated!) as never, 200 as const);
  });

  app.openapi(deleteJob, async (c) => {
    const userId = c.get("user").id;
    const role = c.get("user").demo ? "student" : c.get("user").role;
    const { id } = c.req.valid("param");
    const row = await c.env.DB.prepare(`SELECT * FROM jobs WHERE id = ?1 AND deleted = 0`).bind(id).first<Record<string, unknown>>();
    if (!row) throw notFound();
    if (!canEditJob(row, userId, role)) throw forbidden("只能删除自己的私人岗位");
    await c.env.DB.batch([c.env.DB.prepare(`UPDATE jobs SET deleted = 1, updated_at = ?1 WHERE id = ?2`).bind(nowIso(), id)]);
    return c.body(null, 204 as const);
  });

  app.openapi(parseRequirements, async (c) => {
    const userId = c.get("user").id;
    const role = c.get("user").demo ? "student" : c.get("user").role;
    const { id } = c.req.valid("param");
    const row = await c.env.DB.prepare(`SELECT * FROM jobs WHERE id = ?1 AND deleted = 0`).bind(id).first<Record<string, unknown>>();
    if (!row) throw notFound();
    if (!canEditJob(row, userId, role)) throw forbidden("只能解析自己的岗位");
    const operationId = await startOperation(c.env, userId, "parse_job_requirements", { jobId: id }, [row.id, row.job_version, row.jd_text]);
    return c.json({ operationId }, 202 as const) as never;
  });

  app.openapi(getRequirementsDraft, async (c) => {
    const userId = c.get("user").id;
    const role = c.get("user").demo ? "student" : c.get("user").role;
    const { id } = c.req.valid("param");
    const row = await c.env.DB.prepare(`SELECT * FROM jobs WHERE id = ?1 AND deleted = 0`).bind(id).first<Record<string, unknown>>();
    if (!row) throw notFound();
    if (!canEditJob(row, userId, role)) throw forbidden("无权查看该岗位");
    const op = await c.env.DB
      .prepare(`SELECT * FROM async_operations WHERE type = 'parse_job_requirements' AND user_id = ?1 AND status = 'succeeded' AND json_extract(input_json, '$.jobId') = ?2 ORDER BY created_at DESC LIMIT 1`)
      .bind(userId, id)
      .first<Record<string, unknown>>();
    if (!op) throw notFound("尚无就绪的要求解析草稿");
    const result = JSON.parse((op.result_json as string) ?? "{}") as { candidates: { kind: string; value: string; quote: string }[] };
    return c.json({ jobId: id, operationId: op.id as string, status: "ready", candidates: result.candidates ?? [] }, 200 as const) as never;
  });

  app.openapi(confirmRequirements, async (c) => {
    const userId = c.get("user").id;
    const role = c.get("user").demo ? "student" : c.get("user").role;
    const { id } = c.req.valid("param");
    const row = await c.env.DB.prepare(`SELECT * FROM jobs WHERE id = ?1 AND deleted = 0`).bind(id).first<Record<string, unknown>>();
    if (!row) throw notFound();
    if (!canEditJob(row, userId, role)) throw forbidden("无权修改该岗位");
    const op = await c.env.DB
      .prepare(`SELECT * FROM async_operations WHERE type = 'parse_job_requirements' AND user_id = ?1 AND status = 'succeeded' AND json_extract(input_json, '$.jobId') = ?2 ORDER BY created_at DESC LIMIT 1`)
      .bind(userId, id)
      .first<Record<string, unknown>>();
    if (!op) throw notFound("尚无就绪的要求解析草稿");
    const result = JSON.parse((op.result_json as string) ?? "{}") as { candidates: { kind: string; value: string; quote: string }[] };
    const candidates = result.candidates ?? [];
    const now = nowIso();
    const stmts = candidates.map((cand) =>
      c.env.DB
        .prepare(`INSERT INTO job_requirements (id, job_id, job_version, kind, value, quote) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`)
        .bind(uuid(), id, row.job_version, cand.kind, cand.value, cand.quote),
    );
    // 结构化字段冗余写入 jobs，便于筛选
    const degree = candidates.find((x) => x.kind === "degree")?.value ?? row.degree_requirement;
    const location = candidates.find((x) => x.kind === "location")?.value ?? row.location;
    const year = candidates.find((x) => x.kind === "graduation_year")?.value;
    stmts.push(
      c.env.DB
        .prepare(`UPDATE jobs SET degree_requirement = ?2, location = ?3, graduation_year_from = ?4, graduation_year_to = ?4, updated_at = ?5 WHERE id = ?1`)
        .bind(id, degree ?? null, location ?? null, year ? Number(year) : null, now),
    );
    stmts.push(
      c.env.DB
        .prepare(`UPDATE job_versions SET requirements_json = ?3 WHERE job_id = ?1 AND version = ?2`)
        .bind(id, row.job_version, JSON.stringify(candidates)),
    );
    await c.env.DB.batch(stmts);
    return c.json({ count: candidates.length }, 200 as const) as never;
  });
}

export { JOB_FIELDS, canEditJob };
export const ADMIN_MIDDLEWARE = requireAdmin;
