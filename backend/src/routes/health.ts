import { createRoute, z } from "@hono/zod-openapi";
import type { App } from "../app";

export function registerHealthRoutes(app: App): void {
  app.openapi(createRoute({ method: "get", path: "/healthz", tags: ["operations"], responses: {
    200: { description: "D1/R2 与全部 Workflow 绑定就绪", content: { "application/json": { schema: z.object({ status: z.literal("ok") }) } } },
    503: { description: "依赖未就绪", content: { "application/json": { schema: z.object({ status: z.literal("unavailable") }) } } },
  } }), async (c) => {
    try {
      await c.env.DB.prepare("SELECT 1 AS ok").first();
      await c.env.DOCS.list({ prefix: "health/", limit: 1 });
      const bindings = [c.env.PARSE_DOCUMENT, c.env.PARSE_JOB_REQUIREMENTS, c.env.GENERATE_MATCH, c.env.GENERATE_PLAN, c.env.REWRITE_RESUME];
      if (bindings.some(binding => !binding || typeof (binding as { create?: unknown }).create !== "function")) throw new Error("binding unavailable");
      return c.json({ status: "ok" as const }, 200);
    } catch { return c.json({ status: "unavailable" as const }, 503); }
  });
}
