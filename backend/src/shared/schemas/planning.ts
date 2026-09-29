import { z } from "@hono/zod-openapi";
import { baseEntityShape, DateYmdSchema, UuidSchema } from "./common";

// ---------- 两周计划 ----------

export const PlanSchema = z
  .object({
    ...baseEntityShape,
    userId: UuidSchema,
    portfolioId: UuidSchema.nullish(),
    status: z.enum(["draft", "confirmed", "superseded"]),
    ruleVersion: z.string(),
  })
  .openapi("Plan");

export const PlanTaskSchema = z
  .object({
    ...baseEntityShape,
    userId: UuidSchema,
    planId: UuidSchema,
    title: z.string(),
    description: z.string(),
    jobId: UuidSchema.nullish(),
    evidenceId: UuidSchema.nullish(),
    gap: z.string().nullish(),
    estimateHours: z.number().nullish(),
    actualHours: z.number().nullish(),
    scheduledDate: DateYmdSchema.nullish(),
    status: z.enum(["pending", "in_progress", "done", "cancelled"]),
    deps: z.array(UuidSchema),
  })
  .openapi("PlanTask");

export const PlanDetailSchema = z
  .object({ plan: PlanSchema, tasks: z.array(PlanTaskSchema) })
  .openapi("PlanDetail");

export const CreatePlanSchema = z
  .object({
    portfolioId: UuidSchema,
    clientProfileVersion: z.number().int().nullish(),
    clientExperienceVersions: z.array(z.object({ id: UuidSchema, version: z.number().int() })).nullish(),
  })
  .openapi("CreatePlan");

export const TaskUpdateSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    scheduledDate: DateYmdSchema.nullish(),
    estimateHours: z.number().positive().max(100).nullish(),
    actualHours: z.number().nonnegative().max(100).nullish(),
    status: z.enum(["pending", "in_progress", "done", "cancelled"]).optional(),
  })
  .openapi("TaskUpdate");

// ---------- 调整建议 ----------

export const AdjustmentSuggestionSchema = z
  .object({
    ...baseEntityShape,
    userId: UuidSchema,
    planId: UuidSchema,
    trigger: z.enum(["feedback", "profile_change", "task_delay", "task_overrun"]),
    summary: z.string(),
    proposal: z.unknown(),
    status: z.enum(["pending", "accepted", "rejected"]),
  })
  .openapi("AdjustmentSuggestion");

// ---------- 简历改写 ----------

export const RewriteItemSchema = z
  .object({
    id: z.string(),
    originalQuote: z.string(),
    suggestion: z.string(),
    rationale: z.string(),
    quoteVerified: z.boolean(),
    status: z.enum(["pending", "accepted", "rejected"]),
  })
  .openapi("RewriteItem");

export const RewriteSchema = z
  .object({
    ...baseEntityShape,
    userId: UuidSchema,
    experienceId: UuidSchema,
    operationId: UuidSchema.nullish(),
    items: z.array(RewriteItemSchema),
    status: z.enum(["queued", "running", "ready", "failed"]),
    error: z.string().nullish(),
  })
  .openapi("Rewrite");

export const CreateRewriteSchema = z
  .object({ experienceId: UuidSchema })
  .openapi("CreateRewrite");
