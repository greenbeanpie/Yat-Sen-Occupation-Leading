-- Abort on legacy case/whitespace collisions; never merge or rename accounts.
CREATE UNIQUE INDEX idx_users_username_canonical ON users(lower(trim(username))) WHERE username IS NOT NULL;
ALTER TABLE users ADD COLUMN email TEXT;
ALTER TABLE users ADD COLUMN email_verified_at TEXT;
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
