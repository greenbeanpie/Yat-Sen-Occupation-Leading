CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX idx_sessions_expiry ON sessions(expires_at);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE TABLE rate_limits (key TEXT NOT NULL, window INTEGER NOT NULL, hits INTEGER NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(key, window));
CREATE INDEX idx_rate_limits_expiry ON rate_limits(expires_at);
ALTER TABLE parse_drafts ADD COLUMN confirmation_token TEXT;
CREATE INDEX idx_operations_budget ON async_operations(user_id, created_at, status);
CREATE TABLE reminder_push_deliveries (reminder_id TEXT NOT NULL, subscription_id TEXT NOT NULL, PRIMARY KEY(reminder_id, subscription_id));
CREATE INDEX idx_documents_page ON documents(user_id, deleted, created_at, id);
CREATE INDEX idx_portfolios_page ON portfolios(user_id, deleted, created_at, id);
CREATE INDEX idx_plans_page ON plans(user_id, deleted, created_at, id);
CREATE INDEX idx_jobs_page ON jobs(user_id, deleted, created_at, id);
CREATE INDEX idx_reminders_page ON reminders(user_id, status, fire_at, id);
-- Historical sent reminders are complete; do not replay old notifications.
UPDATE reminders SET retry_count = -1 WHERE status = 'sent' AND retry_count = 0;
