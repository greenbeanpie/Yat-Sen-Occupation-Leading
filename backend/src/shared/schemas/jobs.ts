import { isHttpUrl } from "../../application/access";
import { z } from "@hono/zod-openapi";
import { baseEntityShape, DateYmdSchema, UuidSchema } from "./common";

export const JobPayloadSchema = z
  .object({
    title: z.string().min(1).max(200),
    company: z.string().max(200).optional(),
    location: z.string().max(200).nullish(),
    degreeRequirement: z.enum(["associate", "bachelor", "master", "phd", "none"]).nullish(),
    graduationYearFrom: z.number().int().min(2000).max(2100).nullish(),
    graduationYearTo: z.number().int().min(2000).max(2100).nullish(),
    sourceUrl: z.string().max(1000).refine(isHttpUrl, "仅允许绝对 HTTP(S) 来源链接").nullish(),
    deadlineDate: DateYmdSchema.nullish(),
    jdText: z.string().max(50000).optional(),
  })
  .openapi("JobPayload");

export const JobRequirementSchema = z
  .object({ kind: z.string(), value: z.string(), quote: z.string().nullish() })
  .openapi("JobRequirement");

export const JobSchema = z
  .object({
    ...baseEntityShape,
    userId: UuidSchema.nullish(),
    scope: z.enum(["public", "private"]),
    title: z.string(),
    company: z.string(),
    location: z.string().nullish(),
    degreeRequirement: z.string().nullish(),
    graduationYearFrom: z.number().int().nullish(),
    graduationYearTo: z.number().int().nullish(),
    sourceUrl: z.string().nullish(),
    deadlineDate: DateYmdSchema.nullish(),
    status: z.enum(["draft", "published", "archived"]),
    jdText: z.string(),
    jobVersion: z.number().int(),
    requirements: z.array(JobRequirementSchema),
  })
  .openapi("Job");

export const JobListQuerySchema = z
  .object({
    scope: z.enum(["public", "mine"]).optional(),
    q: z.string().max(200).optional(),
    degree: z.string().max(20).optional(),
    location: z.string().max(200).optional(),
  })
  .openapi("JobListQuery");

export const JobListResponseSchema = z
  .object({ items: z.array(JobSchema), nextCursor: z.string().nullable().optional() })
  .openapi("JobListResponse");

export const JobPublishSchema = z
  .object({ action: z.enum(["publish", "archive", "unpublish"]) })
  .openapi("JobPublishRequest");
