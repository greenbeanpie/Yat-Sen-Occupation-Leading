import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  ErrorBodySchema,
  EvidenceBundleSchema,
  EvidencePayloadSchema,
  EvidenceSchema,
  ExperiencePayloadSchema,
  ExperienceSchema,
  ProfilePayloadSchema,
  ProfileSchema,
  SkillPayloadSchema,
  SkillSchema,
  UuidSchema,
} from "../shared/schemas";
import { requireAuth } from "../middleware/auth";
import { quoteRejected, conflict } from "../shared/errors";
import { verifyQuote } from "../domain/quotes";
import { createEntity, deleteEntity, issue, rowToJson, updateEntity } from "../application/entity-writer";
import { PROFILE_CFG, EXPERIENCE_CFG, SKILL_CFG, EVIDENCE_CFG } from "../application/configs";
import { getRow } from "../infra/db/helpers";
import type { AppEnv } from "../env";

type App = OpenAPIHono<AppEnv>;

export { PROFILE_CFG, EXPERIENCE_CFG, SKILL_CFG, EVIDENCE_CFG };

const idParam = { name: "id", in: "params" as const, required: true, schema: UuidSchema };

const getProfile = createRoute({
  method: "get",
  path: "/profile",
  tags: ["profile"],
  middleware: [requireAuth] as const,
  responses: {
    200: { content: { "application/json": { schema: ProfileSchema } }, description: "当前画像（无则返回空壳）" },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
  },
});

const putProfile = createRoute({
  method: "put",
  path: "/profile",
  tags: ["profile"],
  middleware: [requireAuth] as const,
  request: {
    body: {
      content: {
        "application/json": {
          schema: ProfilePayloadSchema.extend({ baseVersion: z.number().int().nullish() }),
        },
      },
      required: true,
    },
  },
  responses: {
    200: { content: { "application/json": { schema: ProfileSchema } }, description: "已保存" },
    409: { content: { "application/json": { schema: ErrorBodySchema } }, description: "版本冲突" },
    422: { content: { "application/json": { schema: ErrorBodySchema } }, description: "参数错误" },
  },
});

const getEvidence = createRoute({
  method: "get",
  path: "/evidence",
  tags: ["evidence"],
  middleware: [requireAuth] as const,
  responses: {
    200: { content: { "application/json": { schema: EvidenceBundleSchema } }, description: "经历、技能与证据关联" },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
  },
});

const postExperience = createRoute({
  method: "post",
  path: "/evidence/experiences",
  tags: ["evidence"],
  middleware: [requireAuth] as const,
  request: { body: { content: { "application/json": { schema: ExperiencePayloadSchema } }, required: true } },
  responses: {
    201: { content: { "application/json": { schema: ExperienceSchema } }, description: "已创建" },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
    422: { content: { "application/json": { schema: ErrorBodySchema } }, description: "参数错误" },
  },
});

const putExperience = createRoute({
  method: "put",
  path: "/evidence/experiences/{id}",
  tags: ["evidence"],
  middleware: [requireAuth] as const,
  request: {
    params: z.object({ id: UuidSchema }),
    body: { content: { "application/json": { schema: ExperiencePayloadSchema.extend({ baseVersion: z.number().int() }) } }, required: true },
  },
  responses: {
    200: { content: { "application/json": { schema: ExperienceSchema } }, description: "已保存（相关分析读取时标记过期）" },
    409: { content: { "application/json": { schema: ErrorBodySchema } }, description: "版本冲突" },
    422: { content: { "application/json": { schema: ErrorBodySchema } }, description: "参数错误" },
  },
});

const deleteExperience = createRoute({
  method: "delete",
  path: "/evidence/experiences/{id}",
  tags: ["evidence"],
  middleware: [requireAuth] as const,
  request: { params: z.object({ id: UuidSchema }) },
  responses: {
    204: { description: "已删除（墓碑）" },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
    404: { content: { "application/json": { schema: ErrorBodySchema } }, description: "不存在" },
  },
});

const postSkill = createRoute({
  method: "post",
  path: "/evidence/skills",
  tags: ["evidence"],
  middleware: [requireAuth] as const,
  request: { body: { content: { "application/json": { schema: SkillPayloadSchema } }, required: true } },
  responses: {
    201: { content: { "application/json": { schema: SkillSchema } }, description: "已创建（同名返回已有技能）" },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
  },
});

const deleteSkill = createRoute({
  method: "delete",
  path: "/evidence/skills/{id}",
  tags: ["evidence"],
  middleware: [requireAuth] as const,
  request: { params: z.object({ id: UuidSchema }) },
  responses: {
    204: { description: "已删除（墓碑）" },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
    404: { content: { "application/json": { schema: ErrorBodySchema } }, description: "不存在" },
  },
});

const postLink = createRoute({
  method: "post",
  path: "/evidence/links",
  tags: ["evidence"],
  middleware: [requireAuth] as const,
  request: { body: { content: { "application/json": { schema: EvidencePayloadSchema } }, required: true } },
  responses: {
    201: { content: { "application/json": { schema: EvidenceSchema } }, description: "引用命中原文，已创建待确认证据" },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
    422: { content: { "application/json": { schema: ErrorBodySchema } }, description: "引用未命中原文或参数错误" },
  },
});

const putLink = createRoute({
  method: "put",
  path: "/evidence/links/{id}",
  tags: ["evidence"],
  middleware: [requireAuth] as const,
  request: {
    params: z.object({ id: UuidSchema }),
    body: { content: { "application/json": { schema: EvidencePayloadSchema } }, required: true },
  },
  responses: {
    200: { content: { "application/json": { schema: EvidenceSchema } }, description: "已更新（确认/缺少证据）" },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
    409: { content: { "application/json": { schema: ErrorBodySchema } }, description: "版本冲突" },
  },
});

const deleteLink = createRoute({
  method: "delete",
  path: "/evidence/links/{id}",
  tags: ["evidence"],
  middleware: [requireAuth] as const,
  request: { params: z.object({ id: UuidSchema }) },
  responses: {
    204: { description: "已删除（墓碑）" },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
    404: { content: { "application/json": { schema: ErrorBodySchema } }, description: "不存在" },
  },
});

export function registerProfileRoutes(app: App): void {
  app.openapi(getProfile, async (c) => {
    const userId = c.get("user").id;
    const row = await c.env.DB.prepare(`SELECT * FROM profiles WHERE user_id = ?1`).bind(userId).first<Record<string, unknown>>();
    if (!row) {
      // 空壳画像：profile 行在首次 PUT 时创建
      return c.json(
        {
          id: "",
          userId,
          version: 0,
          deleted: false,
          createdAt: "",
          updatedAt: "",
          targetRoles: [],
          industries: [],
          graduationYear: null,
          degree: null,
          preferredLocations: [],
          weeklyTimeBudgetHours: null,
        },
        200 as const,
      );
    }
    return c.json(rowToJson(PROFILE_CFG, row), 200 as const) as never;
  });

  app.openapi(putProfile, async (c) => {
    const userId = c.get("user").id;
    const { baseVersion, ...payload } = c.req.valid("json");
    const existing = await c.env.DB.prepare(`SELECT * FROM profiles WHERE user_id = ?1`).bind(userId).first<Record<string, unknown>>();
    if (!existing) {
      const { record } = await createEntity(c.env, userId, PROFILE_CFG, payload as Record<string, unknown>);
      return c.json(record as never, 200 as const);
    }
    if (baseVersion !== undefined && baseVersion !== null && baseVersion !== Number(existing.version)) {
      throw conflict("画像已被其他修改更新", rowToJson(PROFILE_CFG, existing)) as never;
    }
    const { record } = await updateEntity(c.env, userId, PROFILE_CFG, existing.id as string, baseVersion ?? null, payload as Record<string, unknown>);
    return c.json(record as never, 200 as const);
  });

  app.openapi(getEvidence, async (c) => {
    const userId = c.get("user").id;
    const [experiences, skills, links] = await Promise.all([
      c.env.DB.prepare(`SELECT * FROM experiences WHERE user_id = ?1 AND deleted = 0 ORDER BY created_at DESC`).bind(userId).all<Record<string, unknown>>(),
      c.env.DB.prepare(`SELECT * FROM skills WHERE user_id = ?1 AND deleted = 0 ORDER BY created_at DESC`).bind(userId).all<Record<string, unknown>>(),
      c.env.DB.prepare(`SELECT * FROM experience_skills WHERE user_id = ?1 AND deleted = 0 ORDER BY created_at DESC`).bind(userId).all<Record<string, unknown>>(),
    ]);
    return c.json(
      {
        experiences: experiences.results.map((r) => rowToJson(EXPERIENCE_CFG, r)),
        skills: skills.results.map((r) => rowToJson(SKILL_CFG, r)),
        links: links.results.map((r) => rowToJson(EVIDENCE_CFG, r)),
      },
      200 as const,
    ) as never;
  });

  app.openapi(postExperience, async (c) => {
    const userId = c.get("user").id;
    const payload = c.req.valid("json");
    const { record } = await createEntity(c.env, userId, EXPERIENCE_CFG, payload as Record<string, unknown>);
    return c.json(record as never, 201 as const);
  });

  app.openapi(putExperience, async (c) => {
    const userId = c.get("user").id;
    const { id } = c.req.valid("param");
    const { baseVersion, ...payload } = c.req.valid("json");
    const { record } = await updateEntity(c.env, userId, EXPERIENCE_CFG, id, baseVersion, payload as Record<string, unknown>);
    return c.json(record as never, 200 as const);
  });

  app.openapi(deleteExperience, async (c) => {
    const userId = c.get("user").id;
    const { id } = c.req.valid("param");
    await deleteEntity(c.env, userId, EXPERIENCE_CFG, id);
    return c.body(null, 204 as const);
  });

  app.openapi(postSkill, async (c) => {
    const userId = c.get("user").id;
    const { name } = c.req.valid("json");
    const existing = await c.env.DB.prepare(`SELECT * FROM skills WHERE user_id = ?1 AND name = ?2 AND deleted = 0`)
      .bind(userId, name.trim())
      .first<Record<string, unknown>>();
    if (existing) return c.json(rowToJson(SKILL_CFG, existing) as never, 201 as const);
    const { record } = await createEntity(c.env, userId, SKILL_CFG, { name: name.trim() });
    return c.json(record as never, 201 as const);
  });

  app.openapi(deleteSkill, async (c) => {
    const userId = c.get("user").id;
    const { id } = c.req.valid("param");
    await deleteEntity(c.env, userId, SKILL_CFG, id);
    return c.body(null, 204 as const);
  });

  app.openapi(postLink, async (c) => {
    const userId = c.get("user").id;
    const { skillId, experienceId, quote } = c.req.valid("json");
    if (!skillId || !experienceId || !quote) throw issue("(body)", "skillId、experienceId 与 quote 均为必填") as never;
    const experience = await getRow(c.env.DB, "experiences", experienceId, userId);
    if (!experience || Number(experience.deleted) === 1) throw issue("experienceId", "经历不存在") as never;
    if (!verifyQuote(experience.description as string, quote).found) {
      throw quoteRejected("引用未在经历原文中命中，请核对原文") as never;
    }
    const skill = await getRow(c.env.DB, "skills", skillId, userId);
    if (!skill || Number(skill.deleted) === 1) throw issue("skillId", "技能不存在") as never;
    const { record } = await createEntity(c.env, userId, EVIDENCE_CFG, { skillId, experienceId, quote, status: "pending" });
    return c.json(record as never, 201 as const);
  });

  app.openapi(putLink, async (c) => {
    const userId = c.get("user").id;
    const { id } = c.req.valid("param");
    const payload = c.req.valid("json");
    const { baseVersion, ...rest } = payload as Record<string, unknown> & { baseVersion?: number };
    const { record } = await updateEntity(c.env, userId, EVIDENCE_CFG, id, baseVersion ?? null, rest);
    return c.json(record as never, 200 as const);
  });

  app.openapi(deleteLink, async (c) => {
    const userId = c.get("user").id;
    const { id } = c.req.valid("param");
    await deleteEntity(c.env, userId, EVIDENCE_CFG, id);
    return c.body(null, 204 as const);
  });
}
