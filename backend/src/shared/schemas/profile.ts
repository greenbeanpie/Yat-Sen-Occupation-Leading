import { z } from "@hono/zod-openapi";
import { baseEntityShape, DateYmdSchema, UuidSchema } from "./common";

export const ProfilePayloadSchema = z
  .object({
    targetRoles: z.array(z.string().min(1)).max(20).optional(),
    industries: z.array(z.string().min(1)).max(20).optional(),
    graduationYear: z.number().int().min(2000).max(2100).nullish(),
    degree: z.enum(["associate", "bachelor", "master", "phd"]).nullish(),
    preferredLocations: z.array(z.string().min(1)).max(20).optional(),
    weeklyTimeBudgetHours: z.number().positive().max(80).nullish(),
  })
  .openapi("ProfilePayload");

export const ProfileSchema = z
  .object({
    ...baseEntityShape,
    userId: UuidSchema,
    targetRoles: z.array(z.string()),
    industries: z.array(z.string()),
    graduationYear: z.number().int().nullish(),
    degree: z.enum(["associate", "bachelor", "master", "phd"]).nullish(),
    preferredLocations: z.array(z.string()),
    weeklyTimeBudgetHours: z.number().nullish(),
  })
  .openapi("Profile");

// ---------- 经历 ----------

export const ExperiencePayloadSchema = z
  .object({
    title: z.string().min(1).max(200),
    organization: z.string().max(200).optional(),
    kind: z.enum(["project", "internship", "research", "competition", "other"]).optional(),
    startDate: DateYmdSchema.nullish(),
    endDate: DateYmdSchema.nullish(),
    description: z.string().min(1).max(20000),
    sourceDocumentId: UuidSchema.nullish(),
  })
  .openapi("ExperiencePayload");

export const ExperienceSchema = z
  .object({
    ...baseEntityShape,
    userId: UuidSchema,
    title: z.string(),
    organization: z.string(),
    kind: z.enum(["project", "internship", "research", "competition", "other"]),
    startDate: DateYmdSchema.nullish(),
    endDate: DateYmdSchema.nullish(),
    description: z.string(),
    sourceDocumentId: UuidSchema.nullish(),
  })
  .openapi("Experience");

// ---------- 技能 ----------

export const SkillPayloadSchema = z
  .object({ name: z.string().min(1).max(100) })
  .openapi("SkillPayload");

export const SkillSchema = z
  .object({ ...baseEntityShape, userId: UuidSchema, name: z.string() })
  .openapi("Skill");

// ---------- 证据关联（技能↔经历原文引用） ----------

export const EvidencePayloadSchema = z
  .object({
    skillId: UuidSchema.optional(),
    experienceId: UuidSchema.optional(),
    quote: z.string().min(1).max(2000).optional(),
    status: z.enum(["pending", "confirmed", "missing_evidence"]).optional(),
  })
  .openapi("EvidencePayload");

export const EvidenceSchema = z
  .object({
    ...baseEntityShape,
    userId: UuidSchema,
    skillId: UuidSchema,
    experienceId: UuidSchema,
    quote: z.string(),
    status: z.enum(["pending", "confirmed", "missing_evidence"]),
  })
  .openapi("Evidence");

export const EvidenceBundleSchema = z
  .object({
    experiences: z.array(ExperienceSchema),
    skills: z.array(SkillSchema),
    links: z.array(EvidenceSchema),
  })
  .openapi("EvidenceBundle");

/** 上传文件后确认解析入库的请求。 */
export const ConfirmParseSchema = z
  .object({ confirm: z.literal(true) })
  .openapi("ConfirmParse");
