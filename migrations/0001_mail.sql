CREATE TABLE inboxes (
  id TEXT PRIMARY KEY,
  address TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  inbox_id TEXT NOT NULL REFERENCES inboxes(id),
  raw_key TEXT NOT NULL UNIQUE,
  envelope_from TEXT NOT NULL,
  envelope_to TEXT NOT NULL,
  subject TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'ready', 'failed')),
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX messages_inbox ON messages(inbox_id, created_at DESC, id DESC);
CREATE INDEX messages_pending ON messages(status, created_at);

CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  inbox_id TEXT NOT NULL REFERENCES inboxes(id),
  idempotency_key TEXT NOT NULL,
  payload TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'sending', 'accepted', 'failed', 'unknown')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at INTEGER NOT NULL,
  provider_result TEXT,
  error TEXT,
  resolution_note TEXT,
  resolved_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(inbox_id, idempotency_key)
);
CREATE INDEX outbox_pending ON outbox(status, available_at);
CREATE INDEX outbox_inbox ON outbox(inbox_id, created_at DESC, id DESC);

CREATE TABLE maintenance (key TEXT PRIMARY KEY, value TEXT NOT NULL);
