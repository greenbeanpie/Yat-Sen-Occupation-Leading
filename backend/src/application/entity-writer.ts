import type { SyncEntity } from "../shared/constants";
import { conflict, invalidRequest, notFound } from "../shared/errors";
import { nowIso, uuid } from "../shared/datetime";
import { changeLogStmt, conditionalChangeLogStmt, getRow } from "../infra/db/helpers";
import type { Env } from "../env";

/** camelCase（契约）→ snake_case（D1 列）。 */
export function camelToSnake(s: string): string {
  return s.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
}

export interface EntityConfig {
  entity: SyncEntity;
  table: string;
  /** 契约字段 → 列配置；json: true 表示该列存 JSON 字符串。 */
  fields: Record<string, { json?: boolean; nullable?: boolean; column?: string }>;
}

/** 从 payload 生成列值（camel → snake，JSON 序列化，nullish → null）。 */
export function buildColumnValues(cfg: EntityConfig, payload: Record<string, unknown>): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, spec] of Object.entries(cfg.fields)) {
    if (!(key in payload)) continue;
    const value = payload[key];
    const column = spec.column ?? camelToSnake(key);
    if (value === undefined || value === null) {
      if (spec.nullable) out[column] = null;
      continue;
    }
    out[column] = spec.json ? JSON.stringify(value) : (value as string | number | boolean);
  }
  return out;
}

/** DB 行 → 契约 JSON（含 baseEntityShape 字段）。 */
export function rowToJson(cfg: EntityConfig, row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: row.id,
    version: Number(row.version),
    deleted: Number(row.deleted ?? 0) === 1,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
  if ("user_id" in row) out.userId = row.user_id;
  for (const [key, spec] of Object.entries(cfg.fields)) {
    const column = spec.column ?? camelToSnake(key);
    if (!(column in row)) continue;
    const raw = row[column];
    if (spec.json) {
      out[key] = raw === null ? [] : JSON.parse(raw as string);
    } else if (raw === null) {
      out[key] = null;
    } else if (typeof raw === "number") {
      out[key] = raw;
    } else {
      out[key] = raw;
    }
  }
  return out;
}

export interface WriteResult {
  record: Record<string, unknown>;
  version: number;
  changed: boolean;
}

/** Extra SQL committed in the same D1 transaction as the entity and its log. */
export interface EntityWriteOptions {
  completionStatements?: (result: WriteResult) => D1PreparedStatement[];
  /** Let sync persist a conflict receipt when the compare-and-swap loses a race. */
  returnOnConflict?: boolean;
}

/**
 * 创建实体：原子写（实体行 + 变更日志 + 附加语句）。
 * payload 必须已由调用方用对应 Zod schema 校验。
 * explicitId 供离线创建的同步路径使用（客户端已生成 UUID）。
 */
export async function createEntity(
  env: Env,
  userId: string,
  cfg: EntityConfig,
  payload: Record<string, unknown>,
  extra?: (id: string) => D1PreparedStatement[],
  explicitId?: string,
  options: EntityWriteOptions = {},
): Promise<WriteResult> {
  const id = explicitId ?? uuid();
  const now = nowIso();
  const columns = buildColumnValues(cfg, payload);
  const colNames = ["id", "user_id", "version", "deleted", "created_at", "updated_at", ...Object.keys(columns)];
  const values: unknown[] = [id, userId, 1, 0, now, now, ...Object.values(columns)];
  const placeholders = colNames.map((_, i) => `?${i + 1}`).join(", ");
  const stmts = [env.DB.prepare(`INSERT INTO ${cfg.table} (${colNames.join(", ")}) VALUES (${placeholders})`).bind(...values)];
  if (extra) stmts.push(...extra(id));

  const record = { id, userId, version: 1, deleted: false, createdAt: now, updatedAt: now, ...hydratePayload(cfg, payload) };
  const result: WriteResult = { record, version: 1, changed: true };
  stmts.push(changeLogStmt(env.DB, { userId, entity: cfg.entity, entityId: id, version: 1, changeType: "upsert", record }, now));
  stmts.push(...(options.completionStatements?.(result) ?? []));
  await env.DB.batch(stmts);
  return result;
}

/** 更新实体：baseVersion 乐观锁；冲突返回 409 + 服务器当前记录。 */
export async function updateEntity(
  env: Env,
  userId: string,
  cfg: EntityConfig,
  id: string,
  baseVersion: number | null | undefined,
  payload: Record<string, unknown>,
  options: EntityWriteOptions = {},
): Promise<WriteResult> {
  const row = await getRow(env.DB, cfg.table, id, userId);
  if (!row) throw notFound();
  const currentVersion = Number(row.version);
  if (baseVersion !== undefined && baseVersion !== null && baseVersion !== currentVersion) {
    throw conflict("记录已被其他修改更新，请先查看服务器版本", rowToJson(cfg, row));
  }
  if (Number(row.deleted) === 1) throw conflict("记录已被删除", rowToJson(cfg, row));
  const columns = buildColumnValues(cfg, payload);
  const versionIndex = Object.keys(columns).length + 3;
  const sets = [...Object.keys(columns).map((c, i) => `${c} = ?${i + 3}`), `version = ?${versionIndex}`, `updated_at = ?${versionIndex + 1}`];
  const newVersion = currentVersion + 1;
  const now = nowIso();
  const record = rowToJson(cfg, { ...row, ...columns, version: newVersion, updated_at: now });
  const result: WriteResult = { record, version: newVersion, changed: true };
  const update = env.DB.prepare(
    `UPDATE ${cfg.table} SET ${sets.join(", ")} WHERE id = ?1 AND user_id = ?2 AND version = ?${versionIndex + 2} AND deleted = 0`,
  ).bind(id, userId, ...Object.values(columns), newVersion, now, currentVersion);
  const statements = [
    update,
    conditionalChangeLogStmt(env.DB, { userId, entity: cfg.entity, entityId: id, version: newVersion, changeType: "upsert", record }, now),
    ...(options.completionStatements?.(result) ?? []),
  ];
  const batchResults = await env.DB.batch(statements);
  const changed = Number(batchResults[0]?.meta.changes ?? 0) === 1;
  if (!changed && !options.returnOnConflict) {
    const current = await getRow(env.DB, cfg.table, id, userId);
    throw conflict("记录已被其他修改更新，请先查看服务器版本", current ? rowToJson(cfg, current) : undefined);
  }
  if (changed) return result;
  const current = await getRow(env.DB, cfg.table, id, userId);
  return { record: current ? rowToJson(cfg, current) : { id, deleted: true }, version: current ? Number(current.version) : currentVersion, changed: false };
}

/** 删除实体：墓碑标记，不物理删除。 */
export async function deleteEntity(
  env: Env,
  userId: string,
  cfg: EntityConfig,
  id: string,
  baseVersion?: number | null,
  options: EntityWriteOptions = {},
): Promise<boolean> {
  const row = await getRow(env.DB, cfg.table, id, userId);
  if (!row) throw notFound();
  const currentVersion = Number(row.version);
  if (baseVersion !== undefined && baseVersion !== null && baseVersion !== currentVersion) {
    throw conflict("记录已被其他修改更新，请先查看服务器版本", rowToJson(cfg, row));
  }
  if (Number(row.deleted) === 1) return false;
  const newVersion = currentVersion + 1;
  const now = nowIso();
  const record = { id, deleted: true };
  const result: WriteResult = { record, version: newVersion, changed: true };
  const batchResults = await env.DB.batch([
    env.DB.prepare(`UPDATE ${cfg.table} SET deleted = 1, version = ?3, updated_at = ?4 WHERE id = ?1 AND user_id = ?2 AND version = ?5 AND deleted = 0`).bind(
      id,
      userId,
      newVersion,
      now,
      currentVersion,
    ),
    conditionalChangeLogStmt(env.DB, {
      userId,
      entity: cfg.entity,
      entityId: id,
      version: newVersion,
      changeType: "delete",
      record,
    }, now),
    ...(options.completionStatements?.(result) ?? []),
  ]);
  const changed = Number(batchResults[0]?.meta.changes ?? 0) === 1;
  if (!changed && !options.returnOnConflict) {
    const current = await getRow(env.DB, cfg.table, id, userId);
    throw conflict("记录已被其他修改更新，请先查看服务器版本", current ? rowToJson(cfg, current) : undefined);
  }
  return changed;
}

function hydratePayload(cfg: EntityConfig, payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(cfg.fields)) {
    if (!(key in payload)) {
      out[key] = spec.json ? [] : null;
      continue;
    }
    const v = payload[key];
    out[key] = v === undefined || v === null ? (spec.json ? [] : null) : v;
  }
  return out;
}

/** 校验辅助：把 zod 校验错误转成统一包络细节。 */
export function issue(field: string, message: string) {
  return invalidRequest([{ field, issue: message }]);
}
