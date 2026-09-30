import { pageRows } from "../infra/pagination";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { ErrorBodySchema, JobListResponseSchema, JobPayloadSchema, JobPublishSchema, JobSchema, UuidSchema } from "../shared/schemas";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { notFound, conflict } from "../shared/errors";
import { jobToJson, jobVersionSnapshot } from "./jobs";
import { nowIso, uuid } from "../shared/datetime";
import type { AppEnv } from "../env";

type App = OpenAPIHono<AppEnv>;

const listAll = createRoute({
  method: "get",
  path: "/admin/jobs",
  tags: ["admin"],
  middleware: [requireAuth, requireAdmin] as const,
  responses: {
    200: { content: { "application/json": { schema: JobListResponseSchema } }, description: "全部公共岗位（含草稿与下架）" },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
    403: { content: { "application/json": { schema: ErrorBodySchema } }, description: "非管理员" },
  },
});

const createPublicJob = createRoute({
  method: "post",
  path: "/admin/jobs",
  tags: ["admin"],
  middleware: [requireAuth, requireAdmin] as const,
  request: { body: { content: { "application/json": { schema: JobPayloadSchema } }, required: true } },
  responses: {
    201: { content: { "application/json": { schema: JobSchema } }, description: "公共岗位已创建（草稿）" },
    403: { content: { "application/json": { schema: ErrorBodySchema } }, description: "非管理员" },
  },
});

const updatePublicJob = createRoute({
  method: "put",
  path: "/admin/jobs/{id}",
  tags: ["admin"],
  middleware: [requireAuth, requireAdmin] as const,
  request: {
    params: z.object({ id: UuidSchema }),
    body: { content: { "application/json": { schema: JobPayloadSchema.extend({ baseVersion: z.number().int() }) } }, required: true },
  },
  responses: {
    200: { content: { "application/json": { schema: JobSchema } }, description: "已保存" },
    403: { content: { "application/json": { schema: ErrorBodySchema } }, description: "非管理员" },
    409: { content: { "application/json": { schema: ErrorBodySchema } }, description: "版本冲突" },
  },
});

const publish = createRoute({
  method: "post",
  path: "/admin/jobs/{id}/publish",
  tags: ["admin"],
  middleware: [requireAuth, requireAdmin] as const,
  request: {
    params: z.object({ id: UuidSchema }),
    body: { content: { "application/json": { schema: JobPublishSchema } }, required: true },
  },
  responses: {
    200: { content: { "application/json": { schema: JobSchema } }, description: "发布/下架/恢复" },
    403: { content: { "application/json": { schema: ErrorBodySchema } }, description: "非管理员" },
  },
});

export function registerAdminRoutes(app: App): void {
  app.openapi(listAll, async (c) => {
    const rows = await pageRows(c, `SELECT * FROM jobs WHERE user_id IS NULL AND deleted = 0 ORDER BY created_at DESC, id DESC`, []);
    return c.json({ items: rows.results.map(jobToJson), nextCursor: rows.nextCursor }, 200 as const) as never;
  });

  app.openapi(createPublicJob, async (c) => {
    const payload = c.req.valid("json");
    const id = uuid();
    const now = nowIso();
    const record = {
      id,
      userId: null,
      scope: "public" as const,
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
           VALUES (?1, NULL, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'draft', ?10, 1, ?11, ?11)`,
        )
        .bind(
          id,
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

  app.openapi(updatePublicJob, async (c) => {
    const { id } = c.req.valid("param");
    const { baseVersion, ...payload } = c.req.valid("json");
    const row = await c.env.DB.prepare(`SELECT * FROM jobs WHERE id = ?1 AND deleted = 0 AND user_id IS NULL`).bind(id).first<Record<string, unknown>>();
    if (!row) throw notFound();
    if (baseVersion !== Number(row.version)) throw conflict("岗位已被其他修改更新", jobToJson(row));
    const jdChanged = payload.jdText !== undefined && payload.jdText !== row.jd_text;
    const newJobVersion = jdChanged ? Number(row.job_version) + 1 : Number(row.job_version);
    const now = nowIso();
    const stmts = [
      c.env.DB
        .prepare(
          `UPDATE jobs SET title = ?2, company = ?3, location = ?4, degree_requirement = ?5, graduation_year_from = ?6, graduation_year_to = ?7,
           source_url = ?8, deadline_date = ?9, jd_text = ?10, job_version = ?11, version = ?12, updated_at = ?13 WHERE id = ?1`,
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

  app.openapi(publish, async (c) => {
    const { id } = c.req.valid("param");
    const { action } = c.req.valid("json");
    const row = await c.env.DB.prepare(`SELECT * FROM jobs WHERE id = ?1 AND deleted = 0 AND user_id IS NULL`).bind(id).first<Record<string, unknown>>();
    if (!row) throw notFound();
    const status = action === "publish" ? "published" : action === "archive" ? "archived" : "draft";
    await c.env.DB.prepare(`UPDATE jobs SET status = ?2, updated_at = ?3 WHERE id = ?1`).bind(id, status, nowIso()).run();
    const updated = await c.env.DB.prepare(`SELECT * FROM jobs WHERE id = ?1`).bind(id).first<Record<string, unknown>>();
    return c.json(jobToJson(updated!) as never, 200 as const);
  });
}
