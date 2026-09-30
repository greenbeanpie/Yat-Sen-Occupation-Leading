-- Additive migration: no rebuild, rename, deletion or credential rewrite.
-- NULL preserves the legacy role for all existing accounts except the verified owner.
ALTER TABLE users ADD COLUMN access_role TEXT CHECK (access_role IN ('student','admin','super_admin'));
ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0,1));
UPDATE users SET access_role='super_admin'
WHERE id='b3c4dacf-3562-4938-8ba7-d102f4cffe05' AND lower(trim(username))='greenbp'
  AND role='admin' AND is_demo=0 AND deleted=0;
CREATE TABLE system_settings (
  id INTEGER PRIMARY KEY CHECK (id=1),
  registration_enabled INTEGER NOT NULL DEFAULT 1 CHECK (registration_enabled IN (0,1))
);
INSERT INTO system_settings (id,registration_enabled) VALUES (1,1);

CREATE TABLE account_role_audit (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  target_user_id TEXT NOT NULL,
  previous_role TEXT NOT NULL,
  new_role TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_account_role_audit_target ON account_role_audit(target_user_id,created_at,id);
