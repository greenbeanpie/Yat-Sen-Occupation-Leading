-- Review-only source cache and globally fenced leases, no jobs or account changes.
CREATE TABLE career_source_cache (
  cache_key TEXT PRIMARY KEY,
  payload TEXT,
  expires_at INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT
);
