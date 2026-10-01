-- Notification delivery preferences and per-device session ownership; preserve history.
ALTER TABLE users ADD COLUMN notify_in_app INTEGER NOT NULL DEFAULT 1 CHECK (notify_in_app IN (0,1));
ALTER TABLE users ADD COLUMN notify_push INTEGER NOT NULL DEFAULT 1 CHECK (notify_push IN (0,1));
ALTER TABLE reminders ADD COLUMN dismissed_at TEXT;
ALTER TABLE push_subscriptions ADD COLUMN session_id TEXT;
-- Legacy subscriptions lack a revocable session binding; re-enable explicitly per device.
UPDATE push_subscriptions SET status='expired', deleted=1 WHERE session_id IS NULL;
CREATE UNIQUE INDEX idx_ticket_notification_event ON reminders(user_id,dedupe_key) WHERE entity='ticket';
CREATE INDEX idx_push_device_session ON push_subscriptions(session_id,status,deleted);
