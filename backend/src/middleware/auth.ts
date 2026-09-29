import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Context, MiddlewareHandler } from "hono";
import { forbidden, unauthorized } from "../shared/errors";
import { getUser, sessionSecret } from "../infra/db/helpers";
import type { AppEnv, Env, SessionUser } from "../env";

const COOKIE_NAME = "yso_session";
const SESSION_TTL_SECONDS = 7 * 24 * 3600;

interface SessionPayload {
  uid: string;
  exp: number;
}

const toBase64Url = (bytes: Uint8Array): string => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const fromBase64Url = (s: string): Uint8Array => {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
};

async function hmac(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return toBase64Url(new Uint8Array(sig));
}

/** 签发演示会话 Cookie（PLAN.md：服务端定角色，演示身份不可作为生产认证）。 */
export async function issueSessionCookie(c: Context<AppEnv>, userId: string): Promise<void> {
  const payload: SessionPayload = { uid: userId, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS };
  const body = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await hmac(body, sessionSecret(c.env));
  setCookie(c, COOKIE_NAME, `${body}.${sig}`, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    secure: true,
    maxAge: SESSION_TTL_SECONDS,
  });
}

export function clearSessionCookie(c: Context<AppEnv>): void {
  deleteCookie(c, COOKIE_NAME, { path: "/" });
}

export async function resolveUser(c: Context<AppEnv>): Promise<SessionUser | null> {
  const raw = getCookie(c, COOKIE_NAME);
  if (!raw) return null;
  const [body, sig] = raw.split(".");
  if (!body || !sig) return null;
  const expected = await hmac(body, sessionSecret(c.env));
  if (sig !== expected) return null;
  let payload: SessionPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(fromBase64Url(body))) as SessionPayload;
  } catch {
    return null;
  }
  if (!payload?.uid || payload.exp < Math.floor(Date.now() / 1000)) return null;
  const row = await getUser(c.env.DB, payload.uid);
  if (!row) return null;
  return {
    id: row.id as string,
    role: row.role as "student" | "admin",
    displayName: row.display_name as string,
    timezone: row.timezone as string,
    notifyTaskDue: Number(row.notify_task_due) === 1,
    notifyInterview: Number(row.notify_interview) === 1,
  };
}

/** 401 未登录；ctx.var.user 提供后续路由使用。 */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = await resolveUser(c);
  if (!user) throw unauthorized();
  c.set("user", user);
  await next();
};

/** 403 非管理员（真实服务不接受前端自行声明管理员身份）。 */
export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = c.get("user");
  if (user.role !== "admin") throw forbidden("仅管理员可执行该操作");
  await next();
};
