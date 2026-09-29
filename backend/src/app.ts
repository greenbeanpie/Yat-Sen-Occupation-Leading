import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { errorBody, AppError } from "./shared/errors";
import { registerSessionRoutes } from "./routes/session";
import { registerProfileRoutes } from "./routes/profile";
import { registerDocumentRoutes } from "./routes/documents";
import { registerOperationRoutes } from "./routes/operations";
import { registerJobRoutes } from "./routes/jobs";
import { registerAdminRoutes } from "./routes/admin";
import { registerMatchingRoutes } from "./routes/matching";
import { registerPlanningRoutes } from "./routes/planning";
import { registerTrackingRoutes } from "./routes/tracking";
import { registerSyncRoutes } from "./routes/sync";
import { registerNotificationRoutes } from "./routes/notifications";
import type { Env, SessionUser } from "./env";

export type AppEnv = { Bindings: Env; Variables: { user: SessionUser } };
export type App = OpenAPIHono<AppEnv>;

/** OpenAPI 初始化配置（字段契约的唯一渲染出口）。 */
export const OPENAPI_CONFIG = {
  openapi: "3.0.3",
  info: {
    title: "Yat-Sen 求职辅助后端 API",
    version: "1.0.0",
    description: "画像与证据 / 文档解析 / 岗位 / 匹配与组合 / 计划与改写 / 投递与统计 / 离线同步 / 通知",
  },
  servers: [{ url: "/api/v1" }],
} as const;

/** 严格 CORS 白名单：仅放行 CORS_ORIGIN 明确列出的来源（逗号分隔），无通配符回退。 */
export function allowedOrigins(env: Env | undefined): string[] {
  const raw = env?.CORS_ORIGIN?.trim();
  if (!raw) return ["http://localhost:5173"];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== "*");
}

/**
 * 组装应用。验证失败的 422 也走统一错误包络（可定位字段）。
 * 注意：/api/v1/openapi.json 必须最后注册，才能收录全部路由。
 */
export function createApp(): App {
  const app = new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        const details = result.error.issues.map((i) => ({
          field: i.path.join(".") || "(body)",
          issue: i.message,
        }));
        return c.json(errorBody(new AppError(422, "invalid_request", "请求参数有误", details)), 422) as never;
      }
    },
  }).basePath("/api/v1");

  app.use("/api/v1/*", async (c, next) => {
    const middleware = cors({
      origin: (origin) => (allowedOrigins(c.env).includes(origin) ? origin : null),
      allowHeaders: ["Content-Type", "Authorization"],
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      credentials: true,
      maxAge: 86400,
    });
    return middleware(c, next);
  });

  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(errorBody(err), err.status as 400) as never;
    }
    console.error(JSON.stringify({ event: "unhandled_error", message: err.message, stack: err.stack }));
    return c.json(errorBody(new AppError(500, "internal_error", "服务器内部错误")), 500 as 400) as never;
  });

  app.notFound((c) => c.json(errorBody(new AppError(404, "not_found", "接口不存在")), 404) as never);

  registerSessionRoutes(app);
  registerProfileRoutes(app);
  registerDocumentRoutes(app);
  registerOperationRoutes(app);
  registerJobRoutes(app);
  registerAdminRoutes(app);
  registerMatchingRoutes(app);
  registerPlanningRoutes(app);
  registerTrackingRoutes(app);
  registerSyncRoutes(app);
  registerNotificationRoutes(app);

  app.doc("/openapi.json", OPENAPI_CONFIG as never);

  return app;
}
