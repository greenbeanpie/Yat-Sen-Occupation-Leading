import { z } from "@hono/zod-openapi";
import { baseEntityShape, DateYmdSchema, IsoDateTimeSchema, UuidSchema } from "./common";
import { APPLICATION_STATUSES } from "../constants";

export const ApplicationStatusSchema = z.enum(APPLICATION_STATUSES).openapi("ApplicationStatus");

export const ApplicationPayloadSchema = z
  .object({
    jobId: UuidSchema.nullish(),
    jobTitle: z.string().min(1).max(200),
    company: z.string().max(200).optional(),
    notes: z.string().max(5000).optional(),
    status: ApplicationStatusSchema.optional(),
  })
  .openapi("ApplicationPayload");

export const ApplicationSchema = z
  .object({
    ...baseEntityShape,
    userId: UuidSchema,
    jobId: UuidSchema.nullish(),
    jobTitle: z.string(),
    company: z.string(),
    status: ApplicationStatusSchema,
    notes: z.string(),
  })
  .openapi("Application");

export const ApplicationEventPayloadSchema = z
  .object({
    type: z.enum(["status_change", "interview_scheduled", "feedback", "note"]),
    toStatus: ApplicationStatusSchema.nullish(),
    note: z.string().max(5000).nullish(),
    occurredAt: IsoDateTimeSchema.nullish(),
  })
  .openapi("ApplicationEventPayload");

export const ApplicationEventSchema = z
  .object({
    ...baseEntityShape,
    userId: UuidSchema,
    applicationId: UuidSchema,
    type: z.string(),
    fromStatus: z.string().nullish(),
    toStatus: z.string().nullish(),
    note: z.string().nullish(),
    occurredAt: IsoDateTimeSchema,
  })
  .openapi("ApplicationEvent");

export const InterviewPayloadSchema = z
  .object({
    stage: z.string().max(100).optional(),
    scheduledAt: IsoDateTimeSchema,
    locationOrLink: z.string().max(500).nullish(),
  })
  .openapi("InterviewPayload");

export const InterviewSchema = z
  .object({
    ...baseEntityShape,
    userId: UuidSchema,
    applicationId: UuidSchema,
    stage: z.string(),
    scheduledAt: IsoDateTimeSchema,
    locationOrLink: z.string().nullish(),
    result: z.enum(["pending", "passed", "failed"]),
    feedback: z.string().nullish(),
  })
  .openapi("Interview");

export const TimeEntryPayloadSchema = z
  .object({
    applicationId: UuidSchema.nullish(),
    taskId: UuidSchema.nullish(),
    minutes: z.number().int().positive().max(24 * 60),
    spentOn: DateYmdSchema,
    note: z.string().max(1000).nullish(),
  })
  .openapi("TimeEntryPayload");

export const TimeEntrySchema = z
  .object({
    ...baseEntityShape,
    userId: UuidSchema,
    applicationId: UuidSchema.nullish(),
    taskId: UuidSchema.nullish(),
    minutes: z.number().int(),
    spentOn: DateYmdSchema,
    note: z.string().nullish(),
  })
  .openapi("TimeEntry");

/** 效率统计：获得面试的去重投递数 ÷ 实际工时 × 10；零工时 → data=null（PLAN.md 三）。 */
export const EfficiencyStatsSchema = z
  .object({
    from: DateYmdSchema,
    to: DateYmdSchema,
    interviewedCount: z.number().int(),
    totalHours: z.number(),
    efficiency: z.number().nullish(),
  })
  .openapi("EfficiencyStats");
