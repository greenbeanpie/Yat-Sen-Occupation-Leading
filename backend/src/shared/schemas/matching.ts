import { z } from "@hono/zod-openapi";
import { baseEntityShape, DateYmdSchema, IsoDateTimeSchema, UuidSchema } from "./common";

// ---------- 匹配快照 ----------

export const HardConditionSchema = z
  .object({
    kind: z.string(),
    requirement: z.string(),
    status: z.enum(["met", "unmet", "unknown"]),
    note: z.string().nullish(),
  })
  .openapi("HardCondition");

export const MatchScoresSchema = z
  .object({
    skillCoverage: z.number(),
    evidenceCoverage: z.number(),
    preference: z.number().nullish(),
    total: z.number(),
    coverageNote: z.string(),
  })
  .openapi("MatchScores");

export const QuoteRefSchema = z
  .object({ text: z.string(), source: z.string(), location: z.string().nullish() })
  .openapi("QuoteRef");

export const MatchSnapshotSchema = z
  .object({
    id: UuidSchema,
    jobId: UuidSchema,
    operationId: UuidSchema.nullish(),
    ruleVersion: z.string(),
    inputVersions: z.unknown(),
    hardConditions: z.array(HardConditionSchema),
    scores: MatchScoresSchema,
    gaps: z.array(z.string()),
    explanation: z.unknown(),
    quotes: z.array(QuoteRefSchema),
    status: z.enum(["queued", "running", "ready", "failed", "stale"]),
    error: z.string().nullish(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .openapi("MatchSnapshot");

export const CreateMatchSchema = z
  .object({
    jobId: UuidSchema,
    /** 客户端已知输入版本；与服务端不一致时返回 sync_required，先同步再分析。 */
    clientProfileVersion: z.number().int().nullish(),
    clientExperienceVersions: z.array(z.object({ id: UuidSchema, version: z.number().int() })).nullish(),
  })
  .openapi("CreateMatch");

// ---------- 求职组合 ----------

export const PortfolioItemSchema = z
  .object({
    jobId: UuidSchema,
    pinned: z.boolean(),
    score: z.number(),
    prepHours: z.number().nullish(),
    deadline: DateYmdSchema.nullish(),
    unitBenefit: z.number().nullish(),
    selected: z.boolean(),
    excludedReason: z.string().nullish(),
  })
  .openapi("PortfolioItem");

export const PortfolioSchema = z
  .object({
    ...baseEntityShape,
    userId: UuidSchema,
    timeBudgetHours: z.number(),
    items: z.array(PortfolioItemSchema),
    notes: z.unknown(),
  })
  .openapi("Portfolio");

export const PortfolioRequestSchema = z
  .object({
    timeBudgetHours: z.number().positive().max(200),
    pinnedJobIds: z.array(UuidSchema).max(50).optional(),
    removedJobIds: z.array(UuidSchema).max(50).optional(),
    asOfDate: DateYmdSchema.nullish(),
  })
  .openapi("PortfolioRequest");
