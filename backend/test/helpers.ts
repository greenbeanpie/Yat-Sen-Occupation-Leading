import { Miniflare } from "miniflare";
import * as esbuild from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach } from "vitest";
import { DEMO_USERS } from "../src/shared/constants";
import { invitationHash, invitationToken } from "../src/infra/invitations";
import { MIGRATION_0001 } from "../src/infra/db/schema";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// 每个测试进程独立 bundle 文件，避免并行 esbuild 写同一文件
const bundlePath = join(root, "test", ".tmp", `worker.${process.pid}.${Math.random().toString(36).slice(2, 8)}.mjs`);

// Miniflare 把 D1/R2/cache 等持久化目录放在 os.tmpdir() 下。在受限沙箱（如 Windows
// 沙箱化运行、%TEMP% 只读的 CI）里 workerd 子进程无法在那里建目录，会直接
// std::terminate 或报 SQLITE_CANTOPEN。把临时根目录指到仓库内的 test/.tmp（已 gitignore），
// workerd 就能正常启动。必须在 Miniflare 启动前设置，os.tmpdir() 每次调用都会读这些变量。
const mfTmpRoot = process.env.YSO_TEST_TMP_DIR ?? join(root, "test", ".tmp", "tmp-root");
mkdirSync(mfTmpRoot, { recursive: true });
process.env.TMP = mfTmpRoot;
process.env.TEMP = mfTmpRoot;
process.env.TMPDIR = mfTmpRoot;

interface MfBundle {
  mf: Miniflare;
}

const globalCache = globalThis as typeof globalThis & { __ysoTestMf?: Promise<MfBundle> };

/** 打包 worker 并启动 Miniflare（真实 workerd + D1 + R2），整个测试进程共享一个实例。 */
export function getMf(): Promise<MfBundle> {
  globalCache.__ysoTestMf ??= (async () => {
    mkdirSync(dirname(bundlePath), { recursive: true });
    const bundle = await esbuild.build({
      entryPoints: [join(root, "src", "index.ts")],
      outfile: bundlePath,
      bundle: true,
      write: false,
      format: "esm",
      platform: "neutral",
      mainFields: ["module", "main"],
      target: "es2022",
      external: ["cloudflare:workers", "node:crypto"],
      logLevel: "silent",
    });
    writeFileSync(bundlePath, bundle.outputFiles[0]!.contents);
    const mf = new Miniflare({
      scriptPath: bundlePath,
      modules: true,
      compatibilityDate: "2025-10-11",
      compatibilityFlags: ["nodejs_compat"],
      d1Databases: ["DB"],
      r2Buckets: ["DOCS"],
      d1Persist: false, // 并行测试文件各自实例，避免共享持久化目录的 SQLite 锁冲突
      r2Persist: false,
      bindings: {
        AI_PROVIDER: "mock",
        AI_BASE_URL: "",
        AI_MODEL: "",
        CORS_ORIGIN: "http://localhost:5173",
        DEMO_ENABLED: "true",
        SESSION_SECRET: "test-secret-with-at-least-32-bytes-long",
      },
    });
    return { mf };
  })();
  return globalCache.__ysoTestMf;
}

export const testEnv = { placeholder: true } as never;

const TABLES = [
  "ai_settings_audit", "ai_settings", "career_source_cache", "support_ticket_messages", "support_tickets", "account_role_audit", "system_settings", "invitations", "reminder_push_deliveries", "sessions", "rate_limits", "users", "profiles", "experiences", "skills", "experience_skills",
  "documents", "document_segments", "parse_drafts",
  "jobs", "job_versions", "job_requirements",
  "match_snapshots", "portfolios",
  "plans", "plan_tasks", "adjustment_suggestions",
  "rewrites", "applications", "application_events",
  "interviews", "time_entries", "async_operations",
  "sync_operations", "change_log", "reminders", "push_subscriptions",
];

/** 每个用例：重建表结构 + 演示用户，保证隔离。 */
export async function resetDb(): Promise<void> {
  const { mf } = await getMf();
  const db = await mf.getD1Database("DB");
  await db.batch(TABLES.map((t) => db.prepare(`DROP TABLE IF EXISTS ${t}`)));
  const statements = MIGRATION_0001.split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => db.prepare(s));
  await db.batch(statements);
  const now = new Date().toISOString();
  const seeds = [
    [DEMO_USERS.student, "student", "演示学生"],
    [DEMO_USERS.student2, "student", "演示学生乙"],
    [DEMO_USERS.admin, "admin", "演示管理员"],
  ];
  await db.batch(
    seeds.map(([id, role, name]) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO users (id, role, display_name, timezone, is_demo, created_at, updated_at) VALUES (?1, ?2, ?3, 'Asia/Shanghai', 1, ?4, ?4)`,
        )
        .bind(id, role, name, now),
    ),
  );
}

beforeEach(async () => {
  await resetDb();
});

export const STUDENT = DEMO_USERS.student;
export const STUDENT2 = DEMO_USERS.student2;
export const ADMIN = DEMO_USERS.admin;

const BASE = "http://yso.test/api/v1";

/** 以某演示身份登录，返回 Cookie。 */
export async function loginAs(userId: string): Promise<string> {
  const res = await request(undefined, "/session", {
    method: "POST",
    body: JSON.stringify({ userId }),
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  const cookie = res.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("no session cookie");
  return cookie;
}

/** 真实 workerd HTTP 请求（Miniflare dispatchFetch）。 */
export async function request(cookie: string | undefined, path: string, init: RequestInit = {}): Promise<Response> {
  const { mf } = await getMf();
  const headers = new Headers(init.headers);
  if (cookie) headers.set("Cookie", cookie);
  return mf.dispatchFetch(`${BASE}${path}`, { ...init, headers } as never) as unknown as Response;
}

export async function requestAs(cookie: string, path: string, init: RequestInit = {}): Promise<Response> {
  return request(cookie, path, init);
}

/** Local-only real administrator fixture. Never grants a production account. */
export async function loginRealAdmin(): Promise<string> {
  const res = await request(undefined, "/session/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ invitationCode: await seedInvitation(), username: "admin_" + crypto.randomUUID().slice(0, 16), password: crypto.randomUUID() }) });
  if (!res.ok) throw new Error(`fixture registration failed: ${res.status}`);
  const { user } = await res.json<{ user: { id: string } }>();
  const { mf } = await getMf();
  await (await mf.getD1Database("DB")).prepare("UPDATE users SET role='admin' WHERE id=?1").bind(user.id).run();
  return res.headers.get("set-cookie")!.split(";")[0]!;
}

/** Local-only invitation fixture. Never inserts production invitations. */
export async function seedInvitation(): Promise<string> {
  const token = invitationToken();
  const { mf } = await getMf();
  await (await mf.getD1Database("DB")).prepare("INSERT INTO invitations (id,token_hash,created_by,created_at,expires_at) VALUES (?1,?2,'test-fixture',?3,?4)").bind(crypto.randomUUID(), await invitationHash(token), new Date().toISOString(), new Date(Date.now()+3600_000).toISOString()).run();
  return token;
}
