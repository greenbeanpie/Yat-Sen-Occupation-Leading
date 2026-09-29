-- 由 src/infra/db/schema.ts 生成（npm run gen:migrations），请勿手改

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('student','admin')),
  display_name TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  notify_task_due INTEGER NOT NULL DEFAULT 1,
  notify_interview INTEGER NOT NULL DEFAULT 1,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

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
  sent_at TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_reminders_due ON reminders (status, fire_at);

CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
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

