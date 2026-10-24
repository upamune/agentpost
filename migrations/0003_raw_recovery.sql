-- Keep poisoned/orphaned originals visible without blocking healthy later pages.
CREATE TABLE raw_recovery_failures (
  raw_key TEXT PRIMARY KEY,
  error_code TEXT NOT NULL CHECK(error_code IN ('invalid_metadata', 'missing_inbox', 'index_write_failed')),
  updated_at INTEGER NOT NULL
);
