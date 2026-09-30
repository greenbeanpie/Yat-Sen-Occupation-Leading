#!/usr/bin/env node
/**
 * 部署后冒烟：对已部署（或本地 wrangler dev）的后端跑通演示身份链路。
 *
 * 用法：
 *   node backend/scripts/smoke-deploy.mjs https://greenbp-intern-workbench-backend.<subdomain>.workers.dev
 *   node backend/scripts/smoke-deploy.mjs http://127.0.0.1:8787
 *   node backend/scripts/smoke-deploy.mjs <url> --student <uuid>
 *
 * 检查：会话列表与能力 → 演示身份登录（Cookie）→ 带会话读取身份 → 画像接口 → OpenAPI 文档 →
 *      账号体系（契约含 register/login，未知账号登录返回 401，用于确认迁移 0002 已应用）。
 */
const args = process.argv.slice(2);
const baseArg = args.find((arg) => !arg.startsWith("--"));
const studentFlag = args.indexOf("--student");
const studentOverride = studentFlag >= 0 ? args[studentFlag + 1] : undefined;

if (!baseArg) {
  console.error("用法：node backend/scripts/smoke-deploy.mjs <base-url> [--student <uuid>]");
  process.exit(2);
}

const base = baseArg.replace(/\/+$/, "");
const timeoutMs = 15000;
const results = [];

function record(passed, message) {
  results.push({ passed, message });
  console.log(`  [${passed ? "PASS" : "FAIL"}] ${message}`);
}

async function call(path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: { accept: "application/json", ...(options.headers ?? {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { response, body };
}

console.log(`部署冒烟：${base}`);

try {
  const session = await call("/api/v1/session");
  const demoUsers = session.body?.demoUsers ?? [];
  record(session.response.status === 200, `GET /api/v1/session -> ${session.response.status}`);
  record(
    session.body?.authenticated === false && session.body?.capabilities?.demoMode === true,
    "未登录会话返回 demoMode 能力",
  );
  record(Array.isArray(demoUsers) && demoUsers.length > 0, `演示身份列表 ${demoUsers.length} 个`);

  const student = studentOverride
    ? { id: studentOverride }
    : demoUsers.find((user) => user.role === "student") ?? demoUsers[0];
  if (!student?.id) {
    record(false, "没有可用于登录的演示身份");
  } else {
    const login = await call("/api/v1/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: student.id }),
    });
    const setCookie = login.response.headers.getSetCookie?.() ?? [login.response.headers.get("set-cookie") ?? ""];
    const cookie = setCookie.map((value) => value.split(";")[0]).find((value) => value.startsWith("yso_session="));
    record(login.response.status === 200 && Boolean(cookie), `POST /api/v1/session -> ${login.response.status}（已签发会话 Cookie）`);
    record(login.body?.user?.id === student.id, "登录响应返回同一演示身份");

    if (cookie) {
      const me = await call("/api/v1/session", { headers: { cookie } });
      record(
        me.response.status === 200 && me.body?.authenticated === true && me.body?.user?.id === student.id,
        "带会话 Cookie 读取当前身份",
      );
      const profile = await call("/api/v1/profile", { headers: { cookie } });
      record(profile.response.status === 200, `GET /api/v1/profile -> ${profile.response.status}`);
      const logout = await call("/api/v1/session", { method: "DELETE", headers: { cookie } });
      record(logout.response.status === 204, `DELETE /api/v1/session -> ${logout.response.status}`);
    }
  }

  const openapi = await call("/api/v1/openapi.json");
  const contractOk = openapi.response.status === 200 && typeof openapi.body?.openapi === "string";
  record(contractOk, `GET /api/v1/openapi.json -> ${openapi.response.status}`);
  // 账号体系：确认迁移 0002 已应用、注册/凭据登录路由已上线（不写入任何数据）。
  const paths = openapi.body?.paths ?? {};
  const registerSchema = openapi.body?.components?.schemas?.RegisterRequest;
  record(registerSchema?.required?.includes("invitationCode") && !registerSchema?.required?.includes("email"), "Registration contract requires invitation and leaves email optional");
  record(Boolean(paths["/api/v1/admin/invitations"]), "Invitation administration contract present");
  const closedRegistration = await call("/api/v1/session/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "smoke_probe_no_invite", password: "smoke-probe-not-a-secret" }),
  });
  record(closedRegistration.response.status === 422 && closedRegistration.body?.error?.details?.some(item => item.field === "invitationCode"), "Registration without an invitation is rejected before account creation");
  record(
    Boolean(paths["/api/v1/session/register"] && paths["/api/v1/session/login"]),
    "契约包含 /session/register 与 /session/login",
  );
  const badLogin = await call("/api/v1/session/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "smoke_probe_no_such_user", password: "smoke-probe-not-a-secret" }),
  });
  record(
    badLogin.response.status === 401 && badLogin.body?.error?.code === "unauthorized",
    `未知账号登录被拒 -> ${badLogin.response.status}（证明迁移 0002 已应用）`,
  );
} catch (error) {
  record(false, `请求失败：${error.message}`);
}

const failed = results.filter((item) => !item.passed).length;
console.log(`\n结果：${results.length - failed}/${results.length} 通过`);
if (failed > 0) {
  console.error(`冒烟失败 ${failed} 项，请检查部署、迁移与 secrets。`);
  process.exit(1);
}
console.log("冒烟通过。");
