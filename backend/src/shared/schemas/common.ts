import { z } from "@hono/zod-openapi";

/** 统一错误包络（backend_plan.md 六）。 */
export const ErrorDetailSchema = z
  .object({ field: z.string(), issue: z.string() })
  .openapi("ErrorDetail");

export const ErrorBodySchema = z
  .object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      details: z.array(ErrorDetailSchema).optional(),
      server: z.unknown().optional(),
    }),
  })
  .openapi("ErrorBody");

export const UuidSchema = z.string().uuid().openapi("Uuid");
export const DateYmdSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).openapi("DateYmd");
export const IsoDateTimeSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/)
  .openapi("IsoDateTime");

/** 可同步实体公共字段。 */
export const baseEntityShape = {
  id: UuidSchema,
  version: z.number().int().positive(),
  deleted: z.boolean(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
} as const;

/** 同步批量操作（PLAN.md 2.6 协议：操作 ID、实体 ID、基础版本、修改内容）。 */
export const SyncOpSchema = z
  .object({
    opId: z.string().min(1),
    entity: z.enum([
      "profile",
      "experience",
      "skill",
      "evidence",
      "job",
      "portfolio",
      "task",
      "application",
      "application_event",
      "interview",
      "time_entry",
    ]),
    entityId: UuidSchema.nullish(),
    baseVersion: z.number().int().nonnegative().nullish(),
    action: z.enum(["upsert", "delete"]),
    payload: z.unknown().nullish(),
  })
  .openapi("SyncOperation");

export const SyncResultStatusSchema = z.enum(["applied", "duplicate", "conflict", "rejected"]).openapi("SyncResultStatus");

export const SyncResultSchema = z
  .object({
    opId: z.string(),
    status: SyncResultStatusSchema,
    version: z.number().int().optional(),
    record: z.unknown().optional(),
    error: z.string().optional(),
    details: z.array(ErrorDetailSchema).optional(),
  })
  .openapi("SyncResult");

export const SyncRequestSchema = z
  .object({ operations: z.array(SyncOpSchema).min(1).max(100) })
  .openapi("SyncRequest");

export const SyncResponseSchema = z
  .object({ results: z.array(SyncResultSchema) })
  .openapi("SyncResponse");

export const SyncChangeSchema = z
  .object({
    seq: z.number().int(),
    entity: z.string(),
    entityId: UuidSchema,
    version: z.number().int(),
    changeType: z.enum(["upsert", "delete"]),
    record: z.unknown(),
    changedAt: IsoDateTimeSchema,
  })
  .openapi("SyncChange");

export const SyncChangesResponseSchema = z
  .object({
    cursor: z.number().int(),
    hasMore: z.boolean(),
    changes: z.array(SyncChangeSchema),
  })
  .openapi("SyncChangesResponse");

/** 异步作业（202 + operationId；状态：排队/执行/成功/失败）。 */
export const OperationSchema = z
  .object({
    id: UuidSchema,
    type: z.enum(["parse_document", "generate_match", "generate_plan", "rewrite_resume"]),
    status: z.enum(["queued", "running", "succeeded", "failed"]),
    error: z.string().nullish(),
    resultRef: UuidSchema.nullish(),
    createdAt: IsoDateTimeSchema,
  })
  .openapi("Operation");

export const AcceptedResponseSchema = z
  .object({ operationId: UuidSchema })
  .openapi("AcceptedResponse");
