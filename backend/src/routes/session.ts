import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import {
  CredentialLoginRequestSchema,
  LoginRequestSchema,
  RegisterRequestSchema,
  SessionResponseSchema,
} from "../shared/schemas/session";
import { ErrorBodySchema } from "../shared/schemas/common";
import { DEMO_USERS } from "../shared/constants";
import { ensureDemoUsers, getUser, sessionSecret } from "../infra/db/helpers";
import { hashPassword, verifyPassword } from "../infra/password";
import { clearSessionCookie, issueSessionCookie, resolveUser } from "../middleware/auth";
import { invalidRequest, notFound, unauthorized } from "../shared/errors";
import { canonicalUsername, invitationHash } from "../infra/invitations";
import { rateLimit } from "../infra/rate-limit";
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
    if (c.env.DEMO_ENABLED !== "true") throw notFound("演示身份不存在");
    await ensureDemoUsers(c.env.DB);
    const { userId } = c.req.valid("json");
    const row = await getUser(c.env.DB, userId);
    if (!row || Number(row.is_demo) !== 1 || !(Object.values(DEMO_USERS) as string[]).includes(userId)) throw notFound("演示身份不存在");
    await issueSessionCookie(c, userId);
    return c.json(
      { authenticated: true, user: userPayload(row), capabilities: capabilitiesOf(c.env) },
      200 as const,
    );
  });

  app.openapi(register, async (c) => {
    const input = c.req.valid("json");
    const { password, displayName, email, invitationCode } = input;
    const username = canonicalUsername(input.username);
    sessionSecret(c.env);
    const digest = await invitationHash(invitationCode);
    const now = nowIso();
    const usable = await c.env.DB.prepare(`SELECT id FROM invitations WHERE token_hash=?1 AND consumed_by IS NULL AND revoked_at IS NULL AND expires_at>?2`).bind(digest, now).first();
    const invalidInvite = () => invalidRequest([{ field: "invitationCode", issue: "邀请码无效、已使用或已过期" }], "无法注册");
    if (!usable) throw invalidInvite();
    const taken = await c.env.DB.prepare(`SELECT id FROM users WHERE lower(trim(username)) = ?1`).bind(username).first();
    const nameTaken = () => invalidRequest([{ field: "username", issue: "用户名已被占用" }], "无法注册");
    if (taken) throw nameTaken();
    const id = uuid();
    const passwordHash = await hashPassword(password);
    let results;
    try {
      // Transactional D1 batch: the INSERT rechecks eligibility, then only that
      // inserted account claims the invitation. Unique failures roll back both.
      results = await c.env.DB.batch([
        c.env.DB.prepare(`INSERT INTO users (id, role, display_name, timezone, username, password_hash, email, is_demo, created_at, updated_at)
          SELECT ?1, 'student', ?2, 'Asia/Shanghai', ?3, ?4, ?5, 0, ?6, ?6
          FROM invitations WHERE token_hash=?7 AND consumed_by IS NULL AND revoked_at IS NULL AND expires_at>?6`)
          .bind(id, displayName?.trim() || username, username, passwordHash, email ?? null, nowIso(), digest),
        c.env.DB.prepare(`UPDATE invitations SET consumed_by=?1, consumed_at=?2 WHERE token_hash=?3 AND consumed_by IS NULL AND EXISTS (SELECT 1 FROM users WHERE id=?1)`)
          .bind(id, nowIso(), digest),
      ]);
    } catch (error) {
      if (await c.env.DB.prepare(`SELECT id FROM users WHERE lower(trim(username))=?1`).bind(username).first()) throw nameTaken();
      throw error;
    }
    if (results[0]!.meta.changes !== 1) throw invalidInvite();
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
    const input = c.req.valid("json");
    const { password } = input;
    const username = canonicalUsername(input.username);
    await rateLimit(c.env, `credential:${username}`, 10);
    const row = await c.env.DB
      .prepare(`SELECT * FROM users WHERE lower(trim(username)) = ?1 AND deleted = 0 AND is_demo = 0`)
      .bind(username)
      .first<Record<string, unknown>>();
    // 用户名不存在与密码错误返回同一提示，避免账号枚举。
    if (!row || !(row.password_hash as string | null)) {
      // Equal-cost verification for unknown users; never a valid credential.
      await verifyPassword(password, "pbkdf2-sha256$600000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
      throw unauthorized("用户名或密码不正确");
    }
    if (!(await verifyPassword(password, row.password_hash as string))) throw unauthorized("用户名或密码不正确");
    if ((row.password_hash as string).startsWith("pbkdf2-sha256$100000$")) {
      // Upgrade only after successful verification, without replacing a concurrent credential change.
      await c.env.DB.prepare(`UPDATE users SET password_hash = ?1 WHERE id = ?2 AND password_hash = ?3`)
        .bind(await hashPassword(password), row.id, row.password_hash).run();
    }
    await issueSessionCookie(c, row.id as string);
    return c.json(
      { authenticated: true, user: userPayload(row), capabilities: capabilitiesOf(c.env) },
      200 as const,
    );
  });

  app.openapi(logout, async (c) => {
    await clearSessionCookie(c);
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
