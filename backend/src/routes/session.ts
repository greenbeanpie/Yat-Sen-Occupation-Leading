import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { LoginRequestSchema, SessionResponseSchema } from "../shared/schemas/session";
import { ErrorBodySchema } from "../shared/schemas/common";
import { DEMO_USERS } from "../shared/constants";
import { ensureDemoUsers, getUser } from "../infra/db/helpers";
import { clearSessionCookie, issueSessionCookie, resolveUser } from "../middleware/auth";
import { notFound } from "../shared/errors";
import type { AppEnv, Env } from "../env";

type App = OpenAPIHono<AppEnv>;

const getSession = createRoute({
  method: "get",
  path: "/session",
  tags: ["session"],
  responses: {
    200: {
      content: { "application/json": { schema: SessionResponseSchema } },
      description: "当前身份与能力（未登录时返回演示身份列表）",
    },
  },
});

const login = createRoute({
  method: "post",
  path: "/session",
  tags: ["session"],
  request: { body: { content: { "application/json": { schema: LoginRequestSchema } }, required: true } },
  responses: {
    200: {
      content: { "application/json": { schema: SessionResponseSchema } },
      description: "登录成功（演示身份，服务端签发会话）",
    },
    404: { content: { "application/json": { schema: ErrorBodySchema } }, description: "演示身份不存在" },
    422: { content: { "application/json": { schema: ErrorBodySchema } }, description: "参数错误" },
  },
});

const logout = createRoute({
  method: "delete",
  path: "/session",
  tags: ["session"],
  responses: { 204: { description: "已登出" } },
});

export function registerSessionRoutes(app: App): void {
  app.openapi(getSession, async (c) => {
    if (c.env.DEMO_ENABLED === "true") await ensureDemoUsers(c.env.DB);
    const user = await resolveUser(c);
    if (!user) {
      const demoUsers = c.env.DEMO_ENABLED === "true" ? await listDemoUsers(c.env.DB) : undefined;
      return c.json({ authenticated: false, demoUsers, capabilities: capabilitiesOf(c.env) }, 200 as const);
    }
    return c.json(
      {
        authenticated: true,
        user: { id: user.id, role: user.role, displayName: user.displayName, timezone: user.timezone, demo: true },
        capabilities: capabilitiesOf(c.env),
      },
      200 as const,
    );
  });

  app.openapi(login, async (c) => {
    if (c.env.DEMO_ENABLED === "true") await ensureDemoUsers(c.env.DB);
    const { userId } = c.req.valid("json");
    const row = await getUser(c.env.DB, userId);
    if (!row) throw notFound("演示身份不存在");
    await issueSessionCookie(c, userId);
    return c.json(
      {
        authenticated: true,
        user: {
          id: row.id as string,
          role: row.role as "student" | "admin",
          displayName: row.display_name as string,
          timezone: row.timezone as string,
          demo: true,
        },
        capabilities: capabilitiesOf(c.env),
      },
      200 as const,
    );
  });

  app.openapi(logout, (c) => {
    clearSessionCookie(c);
    return c.body(null, 204 as const);
  });
}

function listDemoUsers(db: Env["DB"]) {
  return db
    .prepare(`SELECT id, role, display_name FROM users WHERE deleted = 0 ORDER BY display_name`)
    .all<{ id: string; role: string; display_name: string }>()
    .then((r) => r.results.map((u) => ({ id: u.id, role: u.role as "student" | "admin", displayName: u.display_name })));
}

function capabilitiesOf(env: Env) {
  return {
    push: Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY),
    offline: true,
    demoMode: env.DEMO_ENABLED === "true",
  };
}

export const DEMO_USER_IDS = DEMO_USERS;
