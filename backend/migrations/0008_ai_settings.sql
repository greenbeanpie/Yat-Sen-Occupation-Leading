-- Nonsecret settings and authenticated ciphertext only, no plaintext API keys.
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
