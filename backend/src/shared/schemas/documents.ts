import { z } from "@hono/zod-openapi";
import { baseEntityShape, DateYmdSchema, IsoDateTimeSchema, UuidSchema } from "./common";

export const DocumentSchema = z
  .object({
    ...baseEntityShape,
    userId: UuidSchema,
    filename: z.string(),
    mimeType: z.string(),
    sizeBytes: z.number().int(),
    pageCount: z.number().int().nullish(),
    status: z.enum(["uploaded", "extracting", "extracted", "parsing", "draft_ready", "confirmed", "failed"]),
    error: z.string().nullish(),
  })
  .openapi("Document");

export const ParseDraftSchema = z
  .object({
    id: UuidSchema,
    documentId: UuidSchema,
    operationId: UuidSchema,
    status: z.enum(["ready", "confirmed", "rejected"]),
    result: z.unknown(),
    createdAt: IsoDateTimeSchema,
  })
  .openapi("ParseDraft");

export const RequirementCandidateSchema = z
  .object({
    kind: z.enum(["degree", "location", "graduation_year", "skill", "experience", "other"]),
    value: z.string(),
    quote: z.string(),
  })
  .openapi("RequirementCandidate");

/** 岗位要求解析草稿（管理员/私人 JD 共用）。 */
export const JobRequirementsDraftSchema = z
  .object({
    jobId: UuidSchema,
    operationId: UuidSchema,
    status: z.enum(["ready", "confirmed", "rejected"]),
    candidates: z.array(RequirementCandidateSchema),
  })
  .openapi("JobRequirementsDraft");
