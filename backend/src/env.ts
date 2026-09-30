import type { OperationType } from "./shared/constants";

/** Hono 应用类型（Bindings + Variables），供中间件与路由统一使用。 */
export type AppEnv = { Bindings: Env; Variables: { user: SessionUser } };

/** Cloudflare 绑定与配置（wrangler.jsonc / .dev.vars）。 */
export interface Env {
  DB: D1Database;
  DOCS: R2Bucket;
  // 测试环境可能未绑定 Workflow（业务处理器可直接调用，见 application/processors.ts）
  PARSE_DOCUMENT?: unknown;
  PARSE_JOB_REQUIREMENTS?: unknown;
  GENERATE_MATCH?: unknown;
  GENERATE_PLAN?: unknown;
  REWRITE_RESUME?: unknown;

  AI_PROVIDER: string;
  AI_BASE_URL: string;
  AI_MODEL: string;
  AI_API_KEY?: string;
  SESSION_SECRET?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  CORS_ORIGIN: string;
  DEMO_ENABLED: string;
}

export interface SessionUser {
  id: string;
  role: "student" | "admin" | "super_admin";
  displayName: string;
  timezone: string;
  notifyTaskDue: boolean;
  notifyInterview: boolean;
  /** 演示身份（userId 直登）为 true；真实注册账号为 false。 */
  demo: boolean;
}

export interface OperationRef {
  id: string;
  type: OperationType;
  status: "queued" | "running" | "succeeded" | "failed";
}
