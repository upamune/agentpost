CREATE TABLE forwarding_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  destination TEXT,
  updated_at INTEGER NOT NULL
);
INSERT INTO forwarding_settings VALUES (1, NULL, 0);

CREATE TABLE inbox_forwarding (
  inbox_id TEXT PRIMARY KEY REFERENCES inboxes(id),
  mode TEXT NOT NULL CHECK (mode IN ('inherit','off','custom')),
  destination TEXT,
  updated_at INTEGER NOT NULL,
  CHECK ((mode = 'custom' AND destination IS NOT NULL) OR (mode != 'custom' AND destination IS NULL))
);

-- One immutable admission decision per retained message, including skipped mail.
CREATE TABLE forwarding_deliveries (
  message_id TEXT PRIMARY KEY REFERENCES messages(id),
  inbox_id TEXT NOT NULL REFERENCES inboxes(id),
  destination TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','sending','accepted','unknown','blocked','skipped')),
  error TEXT,
  resolved_at INTEGER,
  resolution_note TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX forwarding_inbox ON forwarding_deliveries(inbox_id, created_at);
CREATE INDEX forwarding_attention ON forwarding_deliveries(status, updated_at);
