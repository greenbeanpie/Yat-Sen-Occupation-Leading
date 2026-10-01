/**
 * D1 schema（唯一事实来源）。0002 起采用增量迁移：本文件描述当前结构，
 * `migrations/0001_init.sql` 是已部署库的历史基线，其后结构变化写在 0002+ 增量里；
 * 测试直接 import 本文件执行，全新数据库按 0001+0002… 顺序应用即可得到同一终态。
 * 当前结构未声明外键，引用完整性由应用层校验 + db.batch() 事务保证（backend_plan.md R4）。
 * 所有可同步实体带 id/user_id/version/deleted/created_at/updated_at（backend_plan.md 五）。
 */
export const MIGRATION_0001 = /* sql */ `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('student','admin')),
  access_role TEXT CHECK (access_role IN ('student','admin','super_admin')),
  display_name TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  username TEXT,
  password_hash TEXT,
  email TEXT,
  email_verified_at TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  notify_task_due INTEGER NOT NULL DEFAULT 1,
  notify_interview INTEGER NOT NULL DEFAULT 1,
  notify_in_app INTEGER NOT NULL DEFAULT 1 CHECK (notify_in_app IN (0,1)),
  notify_push INTEGER NOT NULL DEFAULT 1 CHECK (notify_push IN (0,1)),
  deleted INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_users_username ON users (username) WHERE username IS NOT NULL;
CREATE UNIQUE INDEX idx_users_username_canonical ON users(lower(trim(username))) WHERE username IS NOT NULL;

CREATE TABLE system_settings (
  id INTEGER PRIMARY KEY CHECK (id=1),
  registration_enabled INTEGER NOT NULL DEFAULT 1 CHECK (registration_enabled IN (0,1))
);
INSERT INTO system_settings (id,registration_enabled) VALUES (1,1);

CREATE TABLE profiles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  target_roles TEXT NOT NULL DEFAULT '[]',
  industries TEXT NOT NULL DEFAULT '[]',
  graduation_year INTEGER,
  degree TEXT,
  preferred_locations TEXT NOT NULL DEFAULT '[]',
  weekly_time_budget_hours REAL,
  version INTEGER NOT NULL DEFAULT 1,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE experiences (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  organization TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'project',
  start_date TEXT,
  end_date TEXT,
  description TEXT NOT NULL,
  source_document_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_experiences_user ON experiences (user_id);

CREATE TABLE skills (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, name)
);

CREATE TABLE experience_skills (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  experience_id TEXT NOT NULL,
  quote TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','missing_evidence')),
  version INTEGER NOT NULL DEFAULT 1,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_links_skill ON experience_skills (skill_id);
CREATE INDEX idx_links_experience ON experience_skills (experience_id);

CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  page_count INTEGER,
  status TEXT NOT NULL DEFAULT 'uploaded'
    CHECK (status IN ('uploaded','extracting','extracted','parsing','draft_ready','confirmed','failed')),
  error TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_documents_user ON documents (user_id);

CREATE TABLE document_segments (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  page INTEGER,
  text TEXT NOT NULL
);
CREATE INDEX idx_segments_doc ON document_segments (document_id);

CREATE TABLE parse_drafts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  result_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready','confirmed','rejected')),
  input_fingerprint TEXT NOT NULL,
  confirmation_token TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  title TEXT NOT NULL,
  company TEXT NOT NULL DEFAULT '',
  location TEXT,
  degree_requirement TEXT,
  graduation_year_from INTEGER,
  graduation_year_to INTEGER,
  source_url TEXT,
  deadline_date TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  jd_text TEXT NOT NULL DEFAULT '',
  job_version INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_jobs_owner ON jobs (user_id, status);

CREATE TABLE job_versions (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  jd_text TEXT NOT NULL,
  requirements_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE job_requirements (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  job_version INTEGER NOT NULL,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  quote TEXT
);

CREATE TABLE match_snapshots (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  operation_id TEXT,
  rule_version TEXT NOT NULL,
  input_versions TEXT NOT NULL,
  input_fingerprint TEXT NOT NULL,
  hard_conditions_json TEXT NOT NULL DEFAULT '[]',
  scores_json TEXT NOT NULL DEFAULT '{}',
  gaps_json TEXT NOT NULL DEFAULT '[]',
  explanation_json TEXT NOT NULL DEFAULT '{}',
  quotes_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','ready','failed','stale')),
  error TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_matches_user_job ON match_snapshots (user_id, job_id);

CREATE TABLE portfolios (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  time_budget_hours REAL NOT NULL,
  items_json TEXT NOT NULL DEFAULT '[]',
  notes_json TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 1,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE plans (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  portfolio_id TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','confirmed','superseded')),
  operation_id TEXT,
  rule_version TEXT NOT NULL,
  input_fingerprint TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE plan_tasks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  job_id TEXT,
  evidence_id TEXT,
  gap TEXT,
  estimate_hours REAL,
  actual_hours REAL,
  scheduled_date TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','done','cancelled')),
  deps_json TEXT NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 1,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_tasks_plan ON plan_tasks (plan_id);

CREATE TABLE adjustment_suggestions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  trigger TEXT NOT NULL,
  summary TEXT NOT NULL,
  proposal_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected')),
  version INTEGER NOT NULL DEFAULT 1,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE rewrites (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  experience_id TEXT NOT NULL,
  operation_id TEXT,
  input_fingerprint TEXT NOT NULL,
  items_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','ready','failed')),
  error TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE applications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  job_id TEXT,
  job_title TEXT NOT NULL,
  company TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'preparing' CHECK (status IN ('preparing','submitted','interviewing','offered','rejected','withdrawn')),
  notes TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_applications_user ON applications (user_id);

CREATE TABLE application_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  type TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  note TEXT,
  occurred_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_app_events ON application_events (application_id);

CREATE TABLE interviews (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT 'interview',
  scheduled_at TEXT NOT NULL,
  location_or_link TEXT,
  result TEXT NOT NULL DEFAULT 'pending' CHECK (result IN ('pending','passed','failed')),
  feedback TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_interviews_app ON interviews (application_id);

CREATE TABLE time_entries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  application_id TEXT,
  task_id TEXT,
  minutes INTEGER NOT NULL,
  spent_on TEXT NOT NULL,
  note TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_time_entries_user ON time_entries (user_id, spent_on);

CREATE TABLE async_operations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed')),
  input_json TEXT NOT NULL,
  input_fingerprint TEXT NOT NULL,
  result_json TEXT,
  result_ref TEXT,
  error TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE sync_operations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  op_id TEXT NOT NULL,
  request_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, op_id)
);

CREATE TABLE change_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  change_type TEXT NOT NULL,
  record_json TEXT NOT NULL,
  changed_at TEXT NOT NULL
);
CREATE INDEX idx_change_log_user ON change_log (user_id, seq);

CREATE TABLE reminders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  entity_version INTEGER NOT NULL,
  kind TEXT NOT NULL,
  fire_at TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'in_app',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','cancelled','failed')),
  dedupe_key TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  read_at TEXT,
  dismissed_at TEXT,
  push_lease_until TEXT,
  sent_at TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_reminders_due ON reminders (status, fire_at);
CREATE UNIQUE INDEX idx_ticket_notification_event ON reminders(user_id,dedupe_key) WHERE entity='ticket';

CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  user_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired')),
  version INTEGER NOT NULL DEFAULT 1,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, endpoint)
);

CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_by TEXT UNIQUE,
  consumed_at TEXT,
  revoked_at TEXT
);
CREATE INDEX idx_push_device_session ON push_subscriptions(session_id,status,deleted);
CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX idx_sessions_expiry ON sessions(expires_at);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE TABLE rate_limits (key TEXT NOT NULL, window INTEGER NOT NULL, hits INTEGER NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(key, window));
CREATE INDEX idx_rate_limits_expiry ON rate_limits(expires_at);
CREATE INDEX idx_operations_budget ON async_operations(user_id, created_at, status);
CREATE TABLE reminder_push_deliveries (reminder_id TEXT NOT NULL, subscription_id TEXT NOT NULL, PRIMARY KEY(reminder_id, subscription_id));
CREATE INDEX idx_documents_page ON documents(user_id, deleted, created_at, id);
CREATE INDEX idx_portfolios_page ON portfolios(user_id, deleted, created_at, id);
CREATE INDEX idx_plans_page ON plans(user_id, deleted, created_at, id);
CREATE INDEX idx_jobs_page ON jobs(user_id, deleted, created_at, id);
CREATE INDEX idx_reminders_page ON reminders(user_id, status, fire_at, id);
-- Private text-only support tickets. Existing account/business tables are untouched.
CREATE TABLE support_tickets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','waiting_user','resolved','closed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_support_tickets_owner ON support_tickets(user_id,created_at,id);
CREATE INDEX idx_support_tickets_created ON support_tickets(created_at,id);
CREATE TABLE support_ticket_messages (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  is_staff INTEGER NOT NULL CHECK (is_staff IN (0,1)),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_support_messages_ticket ON support_ticket_messages(ticket_id,created_at,id);

CREATE TABLE account_role_audit (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  target_user_id TEXT NOT NULL,
  previous_role TEXT NOT NULL,
  new_role TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_account_role_audit_target ON account_role_audit(target_user_id,created_at,id);
-- Review-only source cache and globally fenced leases, no jobs or account changes.
CREATE TABLE career_source_cache (
  cache_key TEXT PRIMARY KEY,
  payload TEXT,
  expires_at INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT
);
-- Nonsecret settings and authenticated ciphertext only, no plaintext API keys.
CREATE TABLE ai_diagnostics (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  event_json TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK(bytes > 0 AND bytes <= 2048 AND bytes = length(CAST(event_json AS BLOB)))
);
CREATE TABLE ai_settings (
  id INTEGER PRIMARY KEY CHECK (id=1),
  version INTEGER NOT NULL DEFAULT 0,
  config_json TEXT,
  secret_ciphertext TEXT,
  updated_at TEXT
);
INSERT INTO ai_settings(id,version) VALUES(1,0);
CREATE TABLE ai_settings_audit (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  previous_version INTEGER NOT NULL,
  new_version INTEGER NOT NULL,
  key_action TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;
