import { rateLimit } from "../infra/rate-limit";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { ErrorBodySchema } from "../shared/schemas";
import { requireAuth } from "../middleware/auth";
import { forbidden } from "../shared/errors";
import type { AppEnv } from "../env";

type App = OpenAPIHono<AppEnv>;

const DemoResetResponseSchema = z
  .object({
    reset: z.literal(true),
    userId: z.string(),
    deletedRows: z.number().int().nonnegative(),
  })
  .openapi("DemoResetResponse");

const resetDemo = createRoute({
  method: "post",
  path: "/demo/reset",
  tags: ["demo"],
  middleware: [requireAuth] as const,
  responses: {
    200: {
      content: { "application/json": { schema: DemoResetResponseSchema } },
      description: "已清空当前演示身份的业务数据（公共岗位库不受影响）",
    },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
    403: { content: { "application/json": { schema: ErrorBodySchema } }, description: "非演示环境" },
  },
});

/**
 * 演示身份的数据清理顺序：先删子表再删主表。
 * 公共岗位的 user_id 为 NULL，因此不会受影响。
 */
const RESET_STATEMENTS: readonly string[] = [
  "DELETE FROM reminder_push_deliveries WHERE reminder_id IN (SELECT id FROM reminders WHERE user_id = ?1)",
  "DELETE FROM document_segments WHERE user_id = ?1",
  "DELETE FROM parse_drafts WHERE user_id = ?1",
  "DELETE FROM documents WHERE user_id = ?1",
  "DELETE FROM experience_skills WHERE user_id = ?1",
  "DELETE FROM experiences WHERE user_id = ?1",
  "DELETE FROM skills WHERE user_id = ?1",
  "DELETE FROM profiles WHERE user_id = ?1",
  "DELETE FROM plan_tasks WHERE user_id = ?1",
  "DELETE FROM adjustment_suggestions WHERE user_id = ?1",
  "DELETE FROM plans WHERE user_id = ?1",
  "DELETE FROM portfolios WHERE user_id = ?1",
  "DELETE FROM match_snapshots WHERE user_id = ?1",
  "DELETE FROM rewrites WHERE user_id = ?1",
  "DELETE FROM interviews WHERE user_id = ?1",
  "DELETE FROM application_events WHERE user_id = ?1",
  "DELETE FROM applications WHERE user_id = ?1",
  "DELETE FROM time_entries WHERE user_id = ?1",
  "DELETE FROM reminders WHERE user_id = ?1",
  "DELETE FROM push_subscriptions WHERE user_id = ?1",
  "DELETE FROM sync_operations WHERE user_id = ?1",
  "DELETE FROM async_operations WHERE user_id = ?1",
  "DELETE FROM change_log WHERE user_id = ?1",
  "DELETE FROM job_requirements WHERE job_id IN (SELECT id FROM jobs WHERE user_id = ?1)",
  "DELETE FROM job_versions WHERE job_id IN (SELECT id FROM jobs WHERE user_id = ?1)",
  "DELETE FROM jobs WHERE user_id = ?1",
];

export function registerDemoRoutes(app: App): void {
  app.openapi(resetDemo, async (c) => {
    if (c.env.DEMO_ENABLED !== "true" || !c.get("user").demo) {
      throw forbidden("演示数据重置仅在演示环境开放");
    }
    const userId = c.get("user").id;
    await rateLimit(c.env, `reset:${userId}`, 2, 3600);
    // Delete paginated user-prefix objects before losing their D1 references.
    let cursor: string | undefined;
    do {
      const objects = await c.env.DOCS.list({ prefix: `docs/${userId}/`, cursor });
      if (objects.objects.length) await c.env.DOCS.delete(objects.objects.map((object) => object.key));
      cursor = objects.truncated ? objects.cursor : undefined;
    } while (cursor);
    const results = await c.env.DB.batch(RESET_STATEMENTS.map((sql) => c.env.DB.prepare(sql).bind(userId)));
    const deletedRows = results.reduce((total, result) => total + (result.meta?.changes ?? 0), 0);
    return c.json({ reset: true as const, userId, deletedRows }, 200 as const) as never;
  });
}
