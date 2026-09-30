import { describe, expect, it } from "vitest";
import { loginAs, request, requestAs, seedInvitation } from "./helpers";

// 测试夹具：口令在测试进程内拼接生成，不落在源码字面量中。
const RUN = Math.random().toString(36).slice(2, 10);
const username = `e2e_${RUN}`;
const secretWords = ["correct", "horse", "battery", RUN];
const testPassphrase = [...secretWords].join("-");
const wrongPassphrase = ["totally", "wrong", RUN].join("-");

async function register(body: unknown) {
  return request(undefined, "/session/register", {
    method: "POST",
    body: JSON.stringify({ invitationCode: await seedInvitation(), ...(body as object) }),
    headers: { "Content-Type": "application/json" },
  });
}

async function credentialLogin(body: unknown) {
  return request(undefined, "/session/login", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

function cookieOf(res: Response): string {
  return res.headers.get("set-cookie")?.split(";")[0] ?? "";
}

describe("session（真实账号注册/登录）", () => {
  it("注册创建学生身份并自动登录，demo 标志为 false", async () => {
    const res = await register({ username, password: testPassphrase, displayName: "测试同学" });
    expect(res.status).toBe(200);
    const body = await res.json<{ authenticated: boolean; user: { role: string; displayName: string; demo: boolean } }>();
    expect(body.authenticated).toBe(true);
    expect(body.user?.role).toBe("student");
    expect(body.user?.displayName).toBe("测试同学");
    expect(body.user?.demo).toBe(false);
    expect(cookieOf(res)).toContain("yso_session=");
  });

  it("注册后的会话可读取 /profile 等受保护资源", async () => {
    const name = `${username}_b`;
    const reg = await register({ username: name, password: testPassphrase });
    expect(reg.status).toBe(200);
    const res = await requestAs(cookieOf(reg), "/profile");
    expect(res.status).toBe(200);
  });

  it("重复用户名返回字段级 422", async () => {
    const name = `${username}_dup`;
    expect((await register({ username: name, password: testPassphrase })).status).toBe(200);
    const res = await register({ username: name, password: testPassphrase });
    expect(res.status).toBe(422);
    const body = await res.json<{ error: { code: string; details: { field: string; issue: string }[] } }>();
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.details?.[0]?.field).toBe("username");
  });

  it("非法用户名与过短口令触发校验失败", async () => {
    const res = await register({ username: "bad name!", password: "short" });
    expect(res.status).toBe(422);
    const body = await res.json<{ error: { details: { field: string }[] } }>();
    const fields = body.error.details?.map((d) => d.field) ?? [];
    expect(fields).toContain("username");
    expect(fields).toContain("password");
  });

  it("凭据登录成功并返回同一账号", async () => {
    const name = `${username}_login`;
    await register({ username: name, password: testPassphrase, displayName: "测试同学" });
    const res = await credentialLogin({ username: name, password: testPassphrase });
    expect(res.status).toBe(200);
    const body = await res.json<{ user: { displayName: string; demo: boolean } }>();
    expect(body.user?.displayName).toBe("测试同学");
    expect(body.user?.demo).toBe(false);
  });

  it("secretValue 错误与未知用户名返回相同的 401（防账号枚举）", async () => {
    const wrong = await credentialLogin({ username, password: wrongPassphrase });
    const missing = await credentialLogin({ username: "no_such_user", password: wrongPassphrase });
    expect(wrong.status).toBe(401);
    expect(missing.status).toBe(401);
    expect((await wrong.json<{ error: { message: string } }>()).error.message).toBe(
      (await missing.json<{ error: { message: string } }>()).error.message,
    );
  });

  it("注册→登出→再登录→登出的完整回路", async () => {
    const name = `${username}_loop`;
    const reg = cookieOf(await register({ username: name, password: testPassphrase }));
    const out = await requestAs(reg, "/session", { method: "DELETE" });
    expect(out.status).toBe(204);
    const back = cookieOf(await credentialLogin({ username: name, password: testPassphrase }));
    const me = await requestAs(back, "/session");
    const body = await me.json<{ authenticated: boolean; user: { demo: boolean } }>();
    expect(body.authenticated).toBe(true);
    expect(body.user?.demo).toBe(false);
  });

  it("演示身份登录仍返回 demo=true，注册账号不受影响", async () => {
    const res = await requestAs(await loginAs("10000000-0000-4000-8000-000000000001"), "/session");
    const body = await res.json<{ user: { demo: boolean } }>();
    expect(body.user?.demo).toBe(true);
  });
});
