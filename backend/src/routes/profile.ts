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
import { notImplemented } from "../shared/errors";
import type { Env, SessionUser } from "../env";

type App = OpenAPIHono<{ Bindings: Env; Variables: { user: SessionUser } }>;

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
          schema: ProfilePayloadSchema.extend({ baseVersion: UuidSchema.nullish() }),
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
    200: { content: { "application/json": { schema: ExperienceSchema } }, description: "已保存（相关分析标记过期）" },
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
    201: { content: { "application/json": { schema: SkillSchema } }, description: "已创建" },
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
  app.openapi(getProfile, () => {
    throw notImplemented();
  });
  app.openapi(putProfile, () => {
    throw notImplemented();
  });
  app.openapi(getEvidence, () => {
    throw notImplemented();
  });
  app.openapi(postExperience, () => {
    throw notImplemented();
  });
  app.openapi(putExperience, () => {
    throw notImplemented();
  });
  app.openapi(deleteExperience, () => {
    throw notImplemented();
  });
  app.openapi(postSkill, () => {
    throw notImplemented();
  });
  app.openapi(deleteSkill, () => {
    throw notImplemented();
  });
  app.openapi(postLink, () => {
    throw notImplemented();
  });
  app.openapi(putLink, () => {
    throw notImplemented();
  });
  app.openapi(deleteLink, () => {
    throw notImplemented();
  });
}
