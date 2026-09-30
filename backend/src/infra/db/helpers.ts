import { MIGRATION_0001 } from "./schema";
import { DEMO_USERS, DEFAULT_TIMEZONE } from "../../shared/constants";
import { nowIso } from "../../shared/datetime";
import type { Env } from "../../env";

/** 建表（测试环境直接执行；wrangler 环境用 migrations/0001_init.sql）。 */
export async function ensureSchema(db: D1Database): Promise<void> {
  const statements = MIGRATION_0001.split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => db.prepare(s));
  await db.batch(statements);
}

const SEED_USERS = [
  { id: DEMO_USERS.student, role: "student", name: "演示学生" },
  { id: DEMO_USERS.student2, role: "student", name: "演示学生乙" },
  { id: DEMO_USERS.admin, role: "admin", name: "演示管理员" },
] as const;

/** 演示身份惰性种子（幂等）；演示站不提供真实注册。 */
export async function ensureDemoUsers(db: D1Database): Promise<void> {
  const now = nowIso();
  const stmts = SEED_USERS.map((u) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO users (id, role, display_name, timezone, is_demo, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 1, ?5, ?5)`,
      )
      .bind(u.id, u.role, u.name, DEFAULT_TIMEZONE, now),
  );
  await db.batch(stmts);
}

export async function getUser(db: D1Database, id: string) {
  return db.prepare(`SELECT * FROM users WHERE id = ?1 AND deleted = 0`).bind(id).first<Record<string, unknown>>();
}

/** 通用单行查询助手：按主键 + 可选 user 隔离。 */
export async function getRow(
  db: D1Database,
  table: string,
  id: string,
  userId?: string,
): Promise<Record<string, unknown> | null> {
  const sql = userId
    ? `SELECT * FROM ${table} WHERE id = ?1 AND user_id = ?2`
    : `SELECT * FROM ${table} WHERE id = ?1`;
  const stmt = userId ? db.prepare(sql).bind(id, userId) : db.prepare(sql).bind(id);
  return stmt.first<Record<string, unknown>>();
}

export interface ChangeEntry {
  userId: string;
  entity: string;
  entityId: string;
  version: number;
  changeType: "upsert" | "delete";
  record: unknown;
}

/** 变更日志行（增量同步游标），与业务写入同一 batch 原子提交。 */
export function changeLogStmt(db: D1Database, e: ChangeEntry, changedAt = nowIso()): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO change_log (user_id, entity, entity_id, version, change_type, record_json, changed_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    )
    .bind(e.userId, e.entity, e.entityId, e.version, e.changeType, JSON.stringify(e.record), changedAt);
}

/**
 * Append a change only when the immediately preceding conditional mutation
 * changed one row. Used in D1.batch so optimistic writes and their sync cursor
 * entry commit or roll back together.
 */
export function conditionalChangeLogStmt(db: D1Database, e: ChangeEntry, changedAt = nowIso()): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO change_log (user_id, entity, entity_id, version, change_type, record_json, changed_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 WHERE changes() = 1`,
    )
    .bind(e.userId, e.entity, e.entityId, e.version, e.changeType, JSON.stringify(e.record), changedAt);
}

/** fingerprint 用于“旧输入不得覆盖新数据”核验（backend_plan.md 7.3）。 */
export async function fingerprintOf(parts: unknown[]): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify(parts));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function sessionSecret(env: Env): string {
  const secret = env.SESSION_SECRET;
  if (!secret || new TextEncoder().encode(secret).length < 32) {
    throw new Error("SESSION_SECRET must contain at least 32 bytes");
  }
  return secret;
}
