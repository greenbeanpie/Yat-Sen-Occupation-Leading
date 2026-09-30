import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import {
  CredentialLoginRequestSchema,
  LoginRequestSchema,
  RegisterRequestSchema,
  SessionResponseSchema,
} from "../shared/schemas/session";
import { ErrorBodySchema } from "../shared/schemas/common";
import { DEMO_USERS } from "../shared/constants";
import { ensureDemoUsers, getUser } from "../infra/db/helpers";
import { hashPassword, verifyPassword } from "../infra/password";
import { clearSessionCookie, issueSessionCookie, resolveUser } from "../middleware/auth";
import { invalidRequest, notFound, unauthorized } from "../shared/errors";
import { uuid, nowIso } from "../shared/datetime";
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

const register = createRoute({
  method: "post",
  path: "/session/register",
  tags: ["session"],
  request: { body: { content: { "application/json": { schema: RegisterRequestSchema } }, required: true } },
  responses: {
    200: {
      content: { "application/json": { schema: SessionResponseSchema } },
      description: "注册成功并自动登录（服务端签发会话）",
    },
    422: { content: { "application/json": { schema: ErrorBodySchema } }, description: "用户名不合法或已被占用、口令不满足要求" },
  },
});

const credentialLogin = createRoute({
  method: "post",
  path: "/session/login",
  tags: ["session"],
  request: { body: { content: { "application/json": { schema: CredentialLoginRequestSchema } }, required: true } },
  responses: {
    200: {
      content: { "application/json": { schema: SessionResponseSchema } },
      description: "账号密码登录成功（服务端签发会话）",
    },
    401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "用户名或密码不正确" },
    422: { content: { "application/json": { schema: ErrorBodySchema } }, description: "参数错误" },
  },
});

const logout = createRoute({
  method: "delete",
  path: "/session",
  tags: ["session"],
  responses: { 204: { description: "已登出" } },
});

function userPayload(row: Record<string, unknown>) {
  return {
    id: row.id as string,
    role: row.role as "student" | "admin",
    displayName: row.display_name as string,
    timezone: row.timezone as string,
    demo: Number(row.is_demo ?? 0) === 1,
  };
}

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
        user: {
          id: user.id,
          role: user.role,
          displayName: user.displayName,
          timezone: user.timezone,
          demo: user.demo,
        },
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
      { authenticated: true, user: userPayload(row), capabilities: capabilitiesOf(c.env) },
      200 as const,
    );
  });

  app.openapi(register, async (c) => {
    const { username, password, displayName } = c.req.valid("json");
    const taken = await c.env.DB
      .prepare(`SELECT id FROM users WHERE username = ?1 AND deleted = 0`)
      .bind(username)
      .first<{ id: string }>();
    if (taken) throw invalidRequest([{ field: "username", issue: "用户名已被占用" }], "注册信息有误");
    const id = uuid();
    const now = nowIso();
    await c.env.DB.batch([
      c.env.DB
        .prepare(
          `INSERT INTO users (id, role, display_name, timezone, username, password_hash, is_demo, created_at, updated_at)
           VALUES (?1, 'student', ?2, ?3, ?4, ?5, 0, ?6, ?6)`,
        )
        .bind(id, displayName?.trim() || username, "Asia/Shanghai", username, await hashPassword(password), now),
    ]);
    await issueSessionCookie(c, id);
    return c.json(
      {
        authenticated: true,
        user: {
          id,
          role: "student" as const,
          displayName: displayName?.trim() || username,
          timezone: "Asia/Shanghai",
          demo: false,
        },
        capabilities: capabilitiesOf(c.env),
      },
      200 as const,
    );
  });

  app.openapi(credentialLogin, async (c) => {
    const { username, password } = c.req.valid("json");
    const row = await c.env.DB
      .prepare(`SELECT * FROM users WHERE username = ?1 AND deleted = 0`)
      .bind(username)
      .first<Record<string, unknown>>();
    // 用户名不存在与密码错误返回同一提示，避免账号枚举。
    if (!row || !(row.password_hash as string | null)) throw unauthorized("用户名或密码不正确");
    if (!(await verifyPassword(password, row.password_hash as string))) throw unauthorized("用户名或密码不正确");
    await issueSessionCookie(c, row.id as string);
    return c.json(
      { authenticated: true, user: userPayload(row), capabilities: capabilitiesOf(c.env) },
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
    .prepare(`SELECT id, role, display_name FROM users WHERE deleted = 0 AND is_demo = 1 ORDER BY display_name`)
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
