import { createRoute, z } from "@hono/zod-openapi";
import type { App } from "../app";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { ErrorBodySchema, UuidSchema } from "../shared/schemas";
import { invitationToken, invitationHash } from "../infra/invitations";
import { nowIso, uuid } from "../shared/datetime";
import { notFound } from "../shared/errors";

const metadata = z.object({ id: UuidSchema, createdAt: z.string(), expiresAt: z.string(), consumedAt: z.string().nullable(), revokedAt: z.string().nullable() });
const denied = { 401: { content: { "application/json": { schema: ErrorBodySchema } }, description: "Not authenticated" }, 403: { content: { "application/json": { schema: ErrorBodySchema } }, description: "Real administrator required" } };
const create = createRoute({ method: "post", path: "/admin/invitations", tags: ["admin"], middleware: [requireAuth, requireAdmin] as const,
  request: { body: { required: true, content: { "application/json": { schema: z.object({ expiresInHours: z.number().int().min(1).max(168).default(24) }) } } } },
  responses: { 201: { content: { "application/json": { schema: z.object({ id: UuidSchema, invitationCode: z.string(), expiresAt: z.string() }) } }, description: "One-time plaintext invitation; do not log or cache" }, ...denied } });
const list = createRoute({ method: "get", path: "/admin/invitations", tags: ["admin"], middleware: [requireAuth, requireAdmin] as const,
  responses: { 200: { content: { "application/json": { schema: z.object({ items: z.array(metadata) }) } }, description: "Latest 100 invitation metadata; no codes or account/contact information" }, ...denied } });
const revoke = createRoute({ method: "delete", path: "/admin/invitations/{id}", tags: ["admin"], middleware: [requireAuth, requireAdmin] as const,
  request: { params: z.object({ id: UuidSchema }) }, responses: { 204: { description: "Revoked; consumed registrations are unaffected" }, 404: { content: { "application/json": { schema: ErrorBodySchema } }, description: "Not found" }, ...denied } });

export function registerInvitationRoutes(app: App): void {
  app.openapi(create, async c => {
    const id = uuid(), token = invitationToken(), now = nowIso();
    const expiresAt = new Date(Date.now() + c.req.valid("json").expiresInHours * 3600_000).toISOString();
    await c.env.DB.prepare("INSERT INTO invitations (id,token_hash,created_by,created_at,expires_at) VALUES (?1,?2,?3,?4,?5)")
      .bind(id, await invitationHash(token), c.get("user").id, now, expiresAt).run();
    c.header("Cache-Control", "no-store");
    return c.json({ id, invitationCode: token, expiresAt }, 201);
  });
  app.openapi(list, async c => {
    const rows = await c.env.DB.prepare("SELECT id,created_at,expires_at,consumed_at,revoked_at FROM invitations ORDER BY created_at DESC,id DESC LIMIT 100").all<{ id: string; created_at: string; expires_at: string; consumed_at: string | null; revoked_at: string | null }>();
    return c.json({ items: rows.results.map(r => ({ id: r.id, createdAt: r.created_at, expiresAt: r.expires_at, consumedAt: r.consumed_at, revokedAt: r.revoked_at })) }, 200);
  });
  app.openapi(revoke, async c => {
    const row = await c.env.DB.prepare("UPDATE invitations SET revoked_at=COALESCE(revoked_at,?1) WHERE id=?2 RETURNING id").bind(nowIso(), c.req.valid("param").id).first();
    if (!row) throw notFound();
    return c.body(null, 204);
  });
}
