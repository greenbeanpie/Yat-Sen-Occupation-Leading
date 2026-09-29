import { Miniflare } from "miniflare";
import * as esbuild from "esbuild";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach } from "vitest";
import { DEMO_USERS } from "../src/shared/constants";
import { MIGRATION_0001 } from "../src/infra/db/schema";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundlePath = join(root, "test", ".tmp", "worker.bundle.mjs");

interface MfBundle {
  mf: Miniflare;
}

const globalCache = globalThis as typeof globalThis & { __ysoTestMf?: Promise<MfBundle> };

/** 打包 worker 并启动 Miniflare（真实 workerd + D1 + R2），整个测试进程共享一个实例。 */
export function getMf(): Promise<MfBundle> {
  globalCache.__ysoTestMf ??= (async () => {
    mkdirSync(dirname(bundlePath), { recursive: true });
    await esbuild.build({
      entryPoints: [join(root, "src", "index.ts")],
      outfile: bundlePath,
      bundle: true,
      format: "esm",
      platform: "neutral",
      mainFields: ["module", "main"],
      target: "es2022",
      external: ["cloudflare:workers"],
      logLevel: "silent",
    });
    const mf = new Miniflare({
      scriptPath: bundlePath,
      modules: true,
      compatibilityDate: "2025-10-11",
      compatibilityFlags: ["nodejs_compat"],
      d1Databases: ["DB"],
      r2Buckets: ["DOCS"],
      bindings: {
        AI_PROVIDER: "mock",
        AI_BASE_URL: "",
        AI_MODEL: "",
        CORS_ORIGIN: "http://localhost:5173",
        DEMO_ENABLED: "true",
        SESSION_SECRET: "test-secret",
      },
    });
    return { mf };
  })();
  return globalCache.__ysoTestMf;
}

export const testEnv = { placeholder: true } as never;

const TABLES = [
  "users", "profiles", "experiences", "skills", "experience_skills",
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
          `INSERT OR IGNORE INTO users (id, role, display_name, timezone, created_at, updated_at) VALUES (?1, ?2, ?3, 'Asia/Shanghai', ?4, ?4)`,
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
