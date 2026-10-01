import type { Env } from '../env';
import { nowIso, uuid } from '../shared/datetime';
/** These statements join the same D1 batch as the source ticket event. */
export async function ticketNotificationStatements(env: Env, ticketId: string, actorId: string, eventKey: string, kind: 'ticket_created' | 'ticket_reply' | 'ticket_status', messageId?: string): Promise<D1PreparedStatement[]> {
  const users = await env.DB.prepare(`SELECT id FROM users WHERE id<>?1 AND deleted=0 AND disabled=0 AND is_demo=0
    AND (COALESCE(access_role,role) IN ('admin','super_admin') OR id=(SELECT user_id FROM support_tickets WHERE id=?2))`).bind(actorId,ticketId).all<{id:string}>();
  const now = nowIso();
  const titles = {ticket_created:'新的支持工单',ticket_reply:'支持工单有新回复',ticket_status:'支持工单状态更新'};
  return users.results.map(user => env.DB.prepare(`INSERT OR IGNORE INTO reminders(id,user_id,entity,entity_id,entity_version,kind,fire_at,channel,status,dedupe_key,title,body,sent_at,created_at,updated_at)
    SELECT ?1,u.id,'ticket',t.id,1,?4,?5,'both','sent',?6,?7,'请打开工单查看更新。',?5,?5,?5
    FROM users u JOIN support_tickets t ON t.id=?3 WHERE u.id=?2 AND u.deleted=0 AND u.disabled=0 AND u.is_demo=0
      AND (t.user_id=u.id OR COALESCE(u.access_role,u.role) IN ('admin','super_admin'))
      AND (?8 IS NULL OR EXISTS(SELECT 1 FROM support_ticket_messages WHERE id=?8 AND ticket_id=t.id))`)
    .bind(uuid(),user.id,ticketId,kind,now,eventKey,titles[kind],messageId ?? null));
}
