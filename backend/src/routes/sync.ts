import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { ErrorBodySchema, SyncChangesResponseSchema, SyncRequestSchema, SyncResponseSchema } from "../shared/schemas";
import { requireAuth } from "../middleware/auth";
import { applySyncBatch, type SyncOpInput } from "../application/sync";
import type { AppEnv } from "../env";

type App = OpenAPIHono<AppEnv>;

const postOperations = createRoute({
  method: "post",
  path: "/sync/operations",
  tags: ["sync"],
  middleware: [requireAuth] as const,
  request: { body: { content: { "application/json": { schema: SyncRequestSchema } }, required: true } },
  responses: {
    200: { content: { "application/json": { schema: SyncResponseSchema } }, description: "逐条回执：applied/duplicate/conflict/rejected（冲突附服务器记录）" },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
    422: { content: { "application/json": { schema: ErrorBodySchema } }, description: "参数错误" },
  },
});

const getChanges = createRoute({
  method: "get",
  path: "/sync/changes",
  tags: ["sync"],
  middleware: [requireAuth] as const,
  request: {
    query: z.object({
      since: z.coerce.number().int().nonnegative().default(0),
      limit: z.coerce.number().int().positive().max(500).default(100),
    }),
  },
  responses: {
    200: { content: { "application/json": { schema: SyncChangesResponseSchema } }, description: "增量变更（含墓碑），cursor 供下次 since 使用" },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
  },
});

export function registerSyncRoutes(app: App): void {
  app.openapi(postOperations, async (c) => {
    const userId = c.get("user").id;
    const body = c.req.valid("json");
    const results = await applySyncBatch(c.env, userId, body.operations as unknown as SyncOpInput[]);
    return c.json({ results }, 200 as const) as never;
  });

  app.openapi(getChanges, async (c) => {
    const userId = c.get("user").id;
    const { since, limit } = c.req.valid("query");
    const rows = await c.env.DB
      .prepare(`SELECT * FROM change_log WHERE user_id = ?1 AND seq > ?2 ORDER BY seq LIMIT ?3`)
      .bind(userId, since, limit + 1)
      .all<Record<string, unknown>>();
    const hasMore = rows.results.length > limit;
    const changes = rows.results.slice(0, limit).map((r) => ({
      seq: Number(r.seq),
      entity: r.entity as string,
      entityId: r.entity_id as string,
      version: Number(r.version),
      changeType: r.change_type as string,
      record: JSON.parse((r.record_json as string) ?? "{}"),
      changedAt: r.changed_at as string,
    }));
    const cursor = changes.length > 0 ? changes[changes.length - 1]!.seq : since;
    return c.json({ cursor, hasMore, changes }, 200 as const) as never;
  });
}
