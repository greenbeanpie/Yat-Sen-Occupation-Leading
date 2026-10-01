import type { Env } from "../env";
import { APPLICATION_CFG } from "./configs";
import { rowToJson, type WriteResult } from "./entity-writer";
import { changeLogStmt, conditionalChangeLogStmt, getRow } from "../infra/db/helpers";
import { nowIso, uuid } from "../shared/datetime";
import { conflict, notFound } from "../shared/errors";

/** Commit the initial timeline entry with the application and creation receipt. */
export function initialApplicationEvent(env: Env, userId: string, result: WriteResult): D1PreparedStatement[] {
  const id = uuid();
  const now = result.record.createdAt as string;
  const record = {
    id, userId, applicationId: result.record.id, version: 1, deleted: false,
    createdAt: now, updatedAt: now, type: "status_change", fromStatus: null,
    toStatus: result.record.status, note: "创建投递记录", occurredAt: now,
  };
  return [
    env.DB.prepare(`INSERT INTO application_events
      (id, user_id, application_id, type, from_status, to_status, note, occurred_at, version, deleted, created_at, updated_at)
      VALUES (?1, ?2, ?3, 'status_change', NULL, ?4, ?5, ?6, 1, 0, ?6, ?6)`)
      .bind(id, userId, result.record.id, result.record.status, record.note, now),
    changeLogStmt(env.DB, { userId, entity: "application_event", entityId: id, version: 1, changeType: "upsert", record }, now),
  ];
}

/** Restore only the parent; child records and their IDs have never been removed. */
export async function restoreApplication(env: Env, userId: string, id: string, baseVersion: number): Promise<Record<string, unknown>> {
  const row = await getRow(env.DB, APPLICATION_CFG.table, id, userId);
  if (!row) throw notFound();
  // A lost restore response can be retried without another version increment.
  if (Number(row.deleted) === 0) return rowToJson(APPLICATION_CFG, row);
  if (Number(row.version) !== baseVersion) throw conflict("投递记录已变化，请刷新后恢复", rowToJson(APPLICATION_CFG, row));
  const now = nowIso();
  const version = baseVersion + 1;
  const record = rowToJson(APPLICATION_CFG, { ...row, deleted: 0, version, updated_at: now });
  const results = await env.DB.batch([
    env.DB.prepare(`UPDATE applications SET deleted = 0, version = ?3, updated_at = ?4
      WHERE id = ?1 AND user_id = ?2 AND deleted = 1 AND version = ?5`).bind(id, userId, version, now, baseVersion),
    conditionalChangeLogStmt(env.DB, { userId, entity: "application", entityId: id, version, changeType: "upsert", record }, now),
    // Do not catch up notifications that elapsed while archived. Future pending
    // reminders become eligible again; previously sent notification history stays.
    env.DB.prepare(`UPDATE reminders SET status = CASE WHEN status = 'pending' THEN 'cancelled' ELSE status END,
      retry_count = -1, updated_at = ?3
      WHERE changes() = 1 AND user_id = ?2 AND entity = 'interview' AND fire_at <= ?3
        AND (status = 'pending' OR (status = 'sent' AND retry_count >= 0))
        AND entity_id IN (SELECT id FROM interviews WHERE application_id = ?1 AND user_id = ?2)`)
      .bind(id, userId, now),
  ]);
  if (Number(results[0]?.meta.changes ?? 0) !== 1) {
    const current = await getRow(env.DB, APPLICATION_CFG.table, id, userId);
    if (current && Number(current.deleted) === 0) return rowToJson(APPLICATION_CFG, current);
    throw conflict("投递记录已变化，请刷新后恢复", current ? rowToJson(APPLICATION_CFG, current) : undefined);
  }
  return record;
}
