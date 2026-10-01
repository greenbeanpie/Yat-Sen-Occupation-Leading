import type { Env } from "../env";
import { nowIso, uuid, zonedMorningUtc } from "../shared/datetime";
import { DEFAULT_TIMEZONE } from "../shared/constants";
import { sendWebPush } from "../infra/push";
import { logJson } from "../infra/logger";

/**
 * 提醒调度（PLAN.md 2.6）：
 * - 任务默认到期当天 09:00（用户时区，服务端按 UTC 调度）
 * - 面试默认提前 1 小时
 * - 提醒绑定实体版本；改期/完成后取消旧提醒；dedupe_key 防重复通知
 */

export interface ReminderInput {
  entity: "task" | "interview";
  entityId: string;
  entityVersion: number;
  kind: string;
  fireAt: string;
  title: string;
  body?: string;
  dedupeKey?: string;
}

export async function createReminder(env: Env, userId: string, input: ReminderInput): Promise<void> {
  const now = nowIso();
  await env.DB
    .prepare(
      `INSERT OR IGNORE INTO reminders (id, user_id, entity, entity_id, entity_version, kind, fire_at, channel, status, dedupe_key, title, body, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'both', 'pending', ?8, ?9, ?10, ?11, ?11)`,
    )
    .bind(
      uuid(),
      userId,
      input.entity,
      input.entityId,
      input.entityVersion,
      input.kind,
      input.fireAt,
      input.dedupeKey ?? `${input.kind}:${input.entityId}`,
      input.title,
      input.body ?? "",
      now,
    )
    .run();
}

/** 取消实体上的未发送提醒（改期/完成后）。 */
export async function cancelRemindersFor(env: Env, userId: string, entity: string, entityId: string): Promise<void> {
  await env.DB
    .prepare(`UPDATE reminders SET status = 'cancelled', updated_at = ?3 WHERE entity = ?1 AND entity_id = ?2 AND (status = 'pending' OR (status = 'sent' AND retry_count >= 0)) AND user_id = ?4`)
    .bind(entity, entityId, nowIso(), userId)
    .run();
}

/** 任务到期提醒：到期日 09:00（用户时区）。 */
export async function scheduleTaskReminder(env: Env, userId: string, taskId: string, taskVersion: number, title: string, scheduledDate: string, timezone: string): Promise<void> {
  if (!scheduledDate) return;
  await cancelRemindersFor(env, userId, "task", taskId);
  const fireAt = zonedMorningUtc(scheduledDate, timezone || DEFAULT_TIMEZONE, 9);
  await createReminder(env, userId, {
    entity: "task",
    entityId: taskId,
    entityVersion: taskVersion,
    kind: "task_due_9am",
    fireAt,
    title: `今日任务：${title}`,
    body: `计划日期 ${scheduledDate}`,
    dedupeKey: `task-due:${taskId}:${scheduledDate}`,
  });
}

/** 面试提醒：开始前 1 小时。 */
export async function scheduleInterviewReminder(env: Env, userId: string, interviewId: string, interviewVersion: number, stage: string, scheduledAt: string): Promise<void> {
  await cancelRemindersFor(env, userId, "interview", interviewId);
  const fireAt = new Date(new Date(scheduledAt).getTime() - 3600_000).toISOString();
  await createReminder(env, userId, {
    entity: "interview",
    entityId: interviewId,
    entityVersion: interviewVersion,
    kind: "interview_1h_before",
    fireAt,
    title: `面试提醒：${stage}`,
    body: `一小时后开始`,
    dedupeKey: `interview-1h:${interviewId}`,
  });
}

export interface CronResult {
  due: number;
  sentInApp: number;
  sentPush: number;
  failed: number;
  expiredSubscriptions: number;
}

// Interview records remain intact when their parent application is archived.
// Delivery eligibility follows the parent instead of destroying reminder data.
const ACTIVE_INTERVIEW_REMINDER = `(entity <> 'interview' OR EXISTS (
  SELECT 1 FROM interviews i JOIN applications a ON a.id = i.application_id AND a.user_id = i.user_id
  WHERE i.id = reminders.entity_id AND i.user_id = reminders.user_id AND i.deleted = 0 AND a.deleted = 0
))`;

/**
 * Cron 每 15 分钟：读取到期提醒 → 站内标记已发送 → 有订阅则推送；
 * 失效订阅（404/410）清理，暂时失败有限重试（≤3 次后失败）。
 */
export async function cronTick(env: Env, now: string = nowIso(), push = sendWebPush): Promise<CronResult> {
  const result: CronResult = { due: 0, sentInApp: 0, sentPush: 0, failed: 0, expiredSubscriptions: 0 };
  const due = await env.DB
    .prepare(`SELECT * FROM reminders WHERE (status = 'pending' OR (status = 'sent' AND retry_count >= 0 AND retry_count < 3)) AND fire_at <= ?1 AND ${ACTIVE_INTERVIEW_REMINDER} ORDER BY fire_at LIMIT 50`)
    .bind(now)
    .all<Record<string, unknown>>();
  result.due = due.results.length;

  for (const candidate of due.results) {
    // Read the current delivery state too: archive + restore can cancel an
    // elapsed reminder after the due list was read while its parent is active again.
    const reminder = await env.DB.prepare(`SELECT * FROM reminders WHERE id = ?1 AND ${ACTIVE_INTERVIEW_REMINDER}
      AND (status = 'pending' OR (status = 'sent' AND retry_count >= 0 AND retry_count < 3)) AND fire_at <= ?2`)
      .bind(candidate.id, now).first<Record<string, unknown>>();
    if (!reminder) continue;
    const userId = reminder.user_id as string;
    const user = await env.DB.prepare(`SELECT notify_task_due, notify_interview, timezone FROM users WHERE id = ?1`).bind(userId).first<{ notify_task_due: number; notify_interview: number }>();
    const kind = reminder.kind as string;
    const enabled = kind.startsWith("task_") ? (user?.notify_task_due ?? 1) === 1 : (user?.notify_interview ?? 1) === 1;

    if (!enabled) {
      // 用户关闭了该类提醒：直接标记发送完成（不再打扰）
      await env.DB.prepare(`UPDATE reminders SET status = 'sent', retry_count = -1, sent_at = ?2, updated_at = ?2 WHERE id = ?1
        AND (status = 'pending' OR (status = 'sent' AND retry_count >= 0)) AND ${ACTIVE_INTERVIEW_REMINDER}`).bind(reminder.id, nowIso()).run();
      continue;
    }

    // 站内提醒：标记发送即出现在通知列表
    if (reminder.status === 'pending') {
      const sent = await env.DB.prepare(`UPDATE reminders SET status = 'sent', sent_at = ?2, updated_at = ?2
        WHERE id = ?1 AND status = 'pending' AND ${ACTIVE_INTERVIEW_REMINDER}`).bind(reminder.id, nowIso()).run();
      if (Number(sent.meta.changes ?? 0) !== 1) continue;
      result.sentInApp++;
    }

    // Reserve an attempt before subscription lookup/network IO; interrupted attempts
    // remain eligible next tick. -1 denotes completed push delivery.
    const attempt = Number(reminder.retry_count ?? 0) + 1;
    const reserved = await env.DB.prepare(`UPDATE reminders SET retry_count = retry_count + 1 WHERE id = ?1 AND status = 'sent'
      AND retry_count = ?2 AND retry_count >= 0 AND retry_count < 3 AND ${ACTIVE_INTERVIEW_REMINDER}`).bind(reminder.id, attempt - 1).run();
    if (Number(reserved.meta.changes ?? 0) !== 1) continue;

    // 浏览器推送：用户主动授权后（存在 active 订阅）才发
    const subs = await env.DB
      .prepare(`SELECT * FROM push_subscriptions WHERE user_id = ?1 AND status = 'active' AND deleted = 0`)
      .bind(userId)
      .all<Record<string, unknown>>();
    if (subs.results.length === 0) {
      await env.DB.prepare(`UPDATE reminders SET retry_count = -1 WHERE id = ?1 AND status = 'sent'`).bind(reminder.id).run();
      continue;
    }

    const payload = JSON.stringify({
      title: reminder.title,
      body: reminder.body,
      tag: reminder.dedupe_key,
      data: { reminderId: reminder.id, entity: reminder.entity, entityId: reminder.entity_id },
    });

    let temporaryFailure = false;
    for (const sub of subs.results) {
      const delivered = await env.DB.prepare(`SELECT reminder_id FROM reminder_push_deliveries WHERE reminder_id = ?1 AND subscription_id = ?2`).bind(reminder.id, sub.id).first();
      if (delivered) continue;
      const stillEligible = await env.DB.prepare(`SELECT id FROM reminders WHERE id = ?1 AND status = 'sent' AND retry_count = ?2 AND ${ACTIVE_INTERVIEW_REMINDER}`)
        .bind(reminder.id, attempt).first();
      if (!stillEligible) break;
      try {
        await push(env, {
          endpoint: sub.endpoint as string,
          p256dh: sub.p256dh as string,
          auth: sub.auth as string,
        }, payload);
        await env.DB.prepare(`INSERT OR IGNORE INTO reminder_push_deliveries (reminder_id, subscription_id) VALUES (?1, ?2)`).bind(reminder.id, sub.id).run();
        result.sentPush++;
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          // 失效订阅清理
          await env.DB.prepare(`UPDATE push_subscriptions SET status = 'expired', updated_at = ?2 WHERE id = ?1`).bind(sub.id, nowIso()).run();
          result.expiredSubscriptions++;
          continue;
        }
        // 暂时失败：有限重试（由下次 cron 处理；超过 3 次标记失败）
        temporaryFailure = true;
        logJson("warn", "push_send_failed", { reminderId: reminder.id as string, statusCode: status });
      }
    }
    const retries = temporaryFailure ? Number(reminder.retry_count ?? 0) + 1 : -1;
    await env.DB.prepare(`UPDATE reminders SET retry_count = ?2, updated_at = ?3 WHERE id = ?1 AND status = 'sent' AND retry_count = ?4`).bind(reminder.id, retries, nowIso(), attempt).run();
    if (retries >= 3) result.failed++;
  }
  const backlog = await env.DB.prepare(`SELECT COUNT(*) AS n FROM reminders WHERE status = 'pending' AND fire_at <= ?1 AND ${ACTIVE_INTERVIEW_REMINDER}`).bind(now).first<{ n: number }>();
  if ((backlog?.n ?? 0) > 0 || result.failed) logJson("warn", "reminder_backlog", { count: backlog?.n ?? 0, failed: result.failed });
  // Crash between reservation and dispatch must not leave an immortal queued record.
  await env.DB.prepare(`UPDATE async_operations SET status = 'failed', error = '排队超时，请重新发起', updated_at = ?1 WHERE status = 'queued' AND created_at < ?2`).bind(now, new Date(new Date(now).getTime() - 30 * 60_000).toISOString()).run();
  await env.DB.prepare(`UPDATE async_operations SET status = 'failed', error = '执行超时，请重新发起', updated_at = ?1 WHERE status = 'running' AND updated_at < ?2`).bind(now, new Date(new Date(now).getTime() - 24 * 3600_000).toISOString()).run();
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM sessions WHERE expires_at <= ?1`).bind(Math.floor(new Date(now).getTime() / 1000)),
    env.DB.prepare(`DELETE FROM rate_limits WHERE expires_at <= ?1`).bind(Math.floor(new Date(now).getTime() / 1000)),
  ]);
  logJson("info", "cron_tick", { ...result });
  return result;
}
