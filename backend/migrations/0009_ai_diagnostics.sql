-- Sanitized metadata only; retained UTF-8 event payloads are trimmed atomically by the writer.
CREATE TABLE ai_diagnostics (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  event_json TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK(bytes > 0 AND bytes <= 2048 AND bytes = length(CAST(event_json AS BLOB)))
);
