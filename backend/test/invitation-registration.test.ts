import { describe, it, expect } from "vitest";
import { getMf, loginRealAdmin, loginAs, ADMIN, STUDENT, request, requestAs, seedInvitation } from "./helpers";
import { invitationHash } from "../src/infra/invitations";
import { hashPassword } from "../src/infra/password";

const json = (body: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const pass = () => crypto.randomUUID();
async function db() { return (await (await getMf()).mf.getD1Database("DB")); }
describe("invitation-only registration", () => {
  it("requires an invitation, accepts no email, canonicalizes names and preserves sessions", async () => {
    const password = pass();
    expect((await request(undefined, "/session/register", json({ username: "Someone", password }))).status).toBe(422);
    const code = await seedInvitation();
    const registration = await request(undefined, "/session/register", json({ username: "Someone", password, invitationCode: code }));
    expect(registration.status).toBe(200);
    const user = await (await db()).prepare("SELECT * FROM users WHERE username='someone'").first();
    expect(user).toMatchObject({ email: null, email_verified_at: null, role: "student", is_demo: 0 });
    expect(String(user!.password_hash)).toMatch(/^pbkdf2-sha256\$600000\$/);
    expect(user!.password_hash).not.toContain(password);
    const login = await request(undefined, "/session/login", json({ username: " SOMEONE ", password }));
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    expect(login.headers.get("set-cookie")).toMatch(/HttpOnly/i);
    expect(login.headers.get("set-cookie")).toMatch(/Secure/i);
    expect((await (await requestAs(cookie, "/session")).json<{ authenticated: boolean }>()).authenticated).toBe(true);
    expect((await requestAs(cookie, "/session", { method: "DELETE" })).status).toBe(204);
    expect((await requestAs(cookie, "/profile")).status).toBe(401);
    expect((await request(undefined, "/session/register", json({ username: "different", password, invitationCode: code }))).status).toBe(422);
  });
  it("a concurrent invitation can create exactly one account", async () => {
    const invitationCode = await seedInvitation();
    const results = await Promise.all(["first_user", "second_user"].map(username => request(undefined, "/session/register", json({ username, password: pass(), invitationCode }))));
    expect(results.map(r => r.status).sort()).toEqual([200, 422]);
    const database = await db();
    expect((await database.prepare("SELECT count(*) n FROM users WHERE is_demo=0").first())!.n).toBe(1);
    const invite = await database.prepare("SELECT * FROM invitations").first();
    expect(invite!.consumed_by).toBeTruthy();
    expect(JSON.stringify(invite)).not.toContain(invitationCode);
  });
  it("duplicate canonical usernames do not consume a second invitation, email is optional and unverified", async () => {
    const password = pass(); const first = await seedInvitation(), second = await seedInvitation();
    expect((await request(undefined, "/session/register", json({ username: "Unique", password, invitationCode: first, email: "person@example.invalid" }))).status).toBe(200);
    expect((await request(undefined, "/session/register", json({ username: "UNIQUE", password, invitationCode: second }))).status).toBe(422);
    expect((await (await db()).prepare("SELECT consumed_by FROM invitations WHERE token_hash=?1").bind(await invitationHash(second)).first())!.consumed_by).toBeNull();
    expect((await (await db()).prepare("SELECT email,email_verified_at FROM users WHERE username='unique'").first())).toEqual({ email: "person@example.invalid", email_verified_at: null });
    expect((await request(undefined, "/session/forgot-password", json({ email: "person@example.invalid" }))).status).toBe(404);
  });
  it("rejects expired, revoked and unknown invitations", async () => {
    const expired = await seedInvitation(), revoked = await seedInvitation();
    const database = await db();
    await database.prepare("UPDATE invitations SET expires_at='2000-01-01T00:00:00.000Z' WHERE token_hash=?1").bind(await invitationHash(expired)).run();
    await database.prepare("UPDATE invitations SET revoked_at=?1 WHERE token_hash=?2").bind(new Date().toISOString(), await invitationHash(revoked)).run();
    for (const code of [expired, revoked, "0".repeat(16)]) expect((await request(undefined, "/session/register", json({ username: "newuser", password: pass(), invitationCode: code }))).status).toBe(422);
    expect((await database.prepare("SELECT count(*) n FROM users WHERE is_demo=0").first())!.n).toBe(0);
  });
  it("concurrent canonical name collisions leave the losing invitation unconsumed", async () => {
    const codes = [await seedInvitation(), await seedInvitation()];
    const results = await Promise.all(codes.map((invitationCode, i) => request(undefined, "/session/register", json({ username: i ? "Race_Name" : "race_name", password: pass(), invitationCode }))));
    expect(results.map(r => r.status).sort()).toEqual([200, 422]);
    expect((await (await db()).prepare("SELECT count(*) n FROM invitations WHERE consumed_by IS NULL").first())!.n).toBe(1);
    expect((await (await db()).prepare("SELECT count(*) n FROM users WHERE is_demo=0").first())!.n).toBe(1);
  });
  it("only real administrators manage invitations and plaintext is returned once", async () => {
    for (const cookie of [undefined, await loginAs(ADMIN), await loginAs(STUDENT)]) {
      for (const path of ["/admin/invitations"]) {
        expect((await request(cookie, path, json({}))).status).toBe(cookie ? 403 : 401);
        expect((await request(cookie, path)).status).toBe(cookie ? 403 : 401);
      }
    }
    const admin = await loginRealAdmin();
    const created = await requestAs(admin, "/admin/invitations", json({}));
    expect(created.status).toBe(201); expect(created.headers.get("cache-control")).toBe("no-store");
    const body = await created.json<{ id: string; invitationCode: string }>();
    expect(body.invitationCode).toMatch(/^[A-Za-z0-9_-]{16}$/);
    const listed = await (await requestAs(admin, "/admin/invitations")).text();
    expect(listed).not.toContain(body.invitationCode); expect(listed).not.toContain("token_hash");
    expect((await requestAs(admin, `/admin/invitations/${body.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await request(undefined, "/session/register", json({ username: "newuser", password: pass(), invitationCode: body.invitationCode }))).status).toBe(422);
  });
  it("preserves mixed-case legacy username, id and password; blocks deleted usernames", async () => {
    const database = await db(), password = pass();
    await database.prepare("INSERT INTO users (id,role,display_name,username,password_hash,created_at,updated_at) VALUES (?1,'student','Legacy','Legacy_Name',?2,'2026','2026')").bind(crypto.randomUUID(), await hashPassword(password)).run();
    const before = await database.prepare("SELECT id,password_hash FROM users WHERE username='Legacy_Name'").first();
    expect((await request(undefined, "/session/login", json({ username: "legacy_name", password }))).status).toBe(200);
    expect(await database.prepare("SELECT id,password_hash FROM users WHERE username='Legacy_Name'").first()).toEqual(before);
    await database.prepare("UPDATE users SET deleted=1 WHERE id=?1").bind(before!.id).run();
    expect((await request(undefined, "/session/login", json({ username: "legacy_name", password }))).status).toBe(401);
    expect((await request(undefined, "/session/register", json({ username: "legacy_name", password, invitationCode: await seedInvitation() }))).status).toBe(422);
  });
  it("rate limits a canonical login name even across distinct IPs", async () => {
    for (let i = 0; i < 10; i++) {
      const init = json({ username: i % 2 ? "missing" : " MISSING ", password: pass() });
      expect((await request(undefined, "/session/login", { ...init, headers: { ...init.headers, "CF-Connecting-IP": `192.0.2.${i}` } })).status).toBe(401);
    }
    const response = await request(undefined, "/session/login", json({ username: "Missing", password: pass() }));
    expect(response.status).toBe(429); expect(response.headers.get("retry-after")).toBeTruthy();
  });
});
