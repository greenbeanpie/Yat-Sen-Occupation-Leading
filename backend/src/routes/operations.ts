import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { ErrorBodySchema, OperationSchema, UuidSchema } from "../shared/schemas";
import { requireAuth } from "../middleware/auth";
import { notFound } from "../shared/errors";
import type { AppEnv } from "../env";

type App = OpenAPIHono<AppEnv>;

const getOperation = createRoute({
  method: "get",
  path: "/operations/{id}",
  tags: ["operations"],
  middleware: [requireAuth] as const,
  request: { params: z.object({ id: UuidSchema }) },
  responses: {
    200: { content: { "application/json": { schema: OperationSchema } }, description: "作业状态（排队/执行/成功/失败）" },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "未登录" },
    404: { content: { "application/json": { schema: ErrorBodySchema } }, description: "不存在" },
  },
});

export function registerOperationRoutes(app: App): void {
  app.openapi(getOperation, async (c) => {
    const userId = c.get("user").id;
    const { id } = c.req.valid("param");
    const row = await c.env.DB.prepare(`SELECT * FROM async_operations WHERE id = ?1 AND user_id = ?2`)
      .bind(id, userId)
      .first<Record<string, unknown>>();
    if (!row) throw notFound();
    return c.json(
      {
        id: row.id as string,
        type: row.type as string,
        status: row.status as string,
        error: (row.error as string | null) ?? null,
        resultRef: (row.result_ref as string | null) ?? null,
        createdAt: row.created_at as string,
      },
      200 as const,
    ) as never;
  });
}
