import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Context, MiddlewareHandler } from "hono";
import { forbidden, unauthorized } from "../shared/errors";
import { getUser, sessionSecret } from "../infra/db/helpers";
import { rateLimit } from "../infra/rate-limit";
import type { AppEnv, SessionUser } from "../env";

const COOKIE_NAME = "yso_session";
const SESSION_TTL_SECONDS = 24 * 3600;
interface SessionPayload { uid: string; jti: string; iat: number; exp: number }
const encoder = new TextEncoder();
function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function decode(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) throw new Error("Invalid base64url");
  const raw = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - s.length % 4) % 4));
  return Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
}
function key(c: Context<AppEnv>, usage: "sign" | "verify") {
  return crypto.subtle.importKey("raw", encoder.encode(sessionSecret(c.env)), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}
export async function readSession(c: Context<AppEnv>): Promise<SessionPayload | null> {
  const raw = getCookie(c, COOKIE_NAME);
  if (!raw || raw.length > 2048) return null;
  const parts = raw.split(".");
  if (parts.length !== 2) return null;
  try {
    const body = parts[0]!;
    const signature = decode(parts[1]!);
    if (!await crypto.subtle.verify("HMAC", await key(c, "verify"), signature as BufferSource, encoder.encode(body))) return null;
    const p = JSON.parse(new TextDecoder().decode(decode(body))) as SessionPayload;
    const now = Math.floor(Date.now() / 1000);
    if (typeof p.uid !== "string" || typeof p.jti !== "string" || !Number.isSafeInteger(p.iat) || !Number.isSafeInteger(p.exp)
      || p.iat > now || p.exp <= now || p.exp - p.iat > SESSION_TTL_SECONDS) return null;
    const row = await c.env.DB.prepare(`SELECT id FROM sessions WHERE id = ?1 AND user_id = ?2 AND expires_at = ?3`).bind(p.jti, p.uid, p.exp).first();
    return row ? p : null;
  } catch { return null; }
}
/** Both credential and demo login issue revocable server-backed sessions. */
export async function issueSessionCookie(c: Context<AppEnv>, userId: string, passwordHash?: string): Promise<void> {
  const signingKey = await key(c, "sign");
  const iat = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = { uid: userId, jti: crypto.randomUUID(), iat, exp: iat + SESSION_TTL_SECONDS };
  const body = encode(encoder.encode(JSON.stringify(payload)));
  const signature = encode(new Uint8Array(await crypto.subtle.sign("HMAC", signingKey, encoder.encode(body))));
  const result = passwordHash === undefined
    ? await c.env.DB.prepare(`INSERT INTO sessions (id, user_id, expires_at) SELECT ?1, ?2, ?3 FROM users WHERE id=?2 AND deleted=0 AND disabled=0`).bind(payload.jti, userId, payload.exp).run()
    : await c.env.DB.prepare(`INSERT INTO sessions (id, user_id, expires_at) SELECT ?1, ?2, ?3 FROM users WHERE id=?2 AND password_hash=?4 AND deleted=0 AND disabled=0 AND is_demo=0`).bind(payload.jti, userId, payload.exp, passwordHash).run();
  if (result.meta.changes !== 1) throw unauthorized('账户状态或密码已变化，请重新登录');
  setCookie(c, COOKIE_NAME, `${body}.${signature}`, { httpOnly: true, sameSite: "Lax", path: "/", secure: true, maxAge: SESSION_TTL_SECONDS });
}
export async function clearSessionCookie(c: Context<AppEnv>): Promise<void> {
  const payload = await readSession(c);
  if (payload) await c.env.DB.prepare(`DELETE FROM sessions WHERE id = ?1 AND user_id = ?2`).bind(payload.jti, payload.uid).run();
  deleteCookie(c, COOKIE_NAME, { path: "/", secure: true, httpOnly: true, sameSite: "Lax" });
}
export async function resolveUser(c: Context<AppEnv>): Promise<SessionUser | null> {
  const payload = await readSession(c);
  if (!payload) return null;
  const row = await getUser(c.env.DB, payload.uid);
  if (!row || (Number(row.is_demo) === 1 && c.env.DEMO_ENABLED !== "true")) return null;
  return { id: row.id as string, role: row.role as "student" | "admin" | "super_admin", displayName: row.display_name as string,
    timezone: row.timezone as string, notifyTaskDue: Number(row.notify_task_due) === 1, notifyInterview: Number(row.notify_interview) === 1, demo: Number(row.is_demo) === 1 };
}
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = await resolveUser(c);
  if (!user) throw unauthorized();
  await rateLimit(c.env, `user:${user.id}`, 120);
  c.set("user", user);
  await next();
};
export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!["admin", "super_admin"].includes(c.get("user").role) || c.get("user").demo) throw forbidden("仅非演示管理员可执行该操作");
  await next();
};

export const requireSuperAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get("user").role !== "super_admin" || c.get("user").demo) throw forbidden("仅超级管理员可执行该操作");
  await next();
};
