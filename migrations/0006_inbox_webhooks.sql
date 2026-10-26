CREATE TABLE inbox_webhooks (
  inbox_id TEXT PRIMARY KEY REFERENCES inboxes(id),
  id TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  encrypted_config TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((enabled = 1 AND encrypted_config IS NOT NULL) OR (enabled = 0 AND encrypted_config IS NULL))
);

CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY,
  inbox_id TEXT NOT NULL REFERENCES inboxes(id),
  webhook_id TEXT NOT NULL,
  message_id TEXT NOT NULL REFERENCES messages(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','delivered','failed','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  claim_token TEXT,
  available_at INTEGER NOT NULL,
  http_status INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (webhook_id, message_id)
);
CREATE INDEX webhook_deliveries_due ON webhook_deliveries(status, available_at);
CREATE INDEX webhook_deliveries_inbox ON webhook_deliveries(inbox_id, created_at);

-- Configuration identity is captured atomically with readiness. Reprocessing the
-- same message under the same configuration cannot create another delivery.
CREATE TRIGGER received_webhook AFTER UPDATE OF status ON messages
WHEN NEW.status = 'ready' AND OLD.status != 'ready'
BEGIN
  INSERT OR IGNORE INTO webhook_deliveries
    (id, inbox_id, webhook_id, message_id, available_at, created_at, updated_at)
  SELECT 'wh_' || replace(w.id, '-', '') || '_' || NEW.id,
    NEW.inbox_id, w.id, NEW.id,
    CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
    CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
    CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
  FROM inbox_webhooks w JOIN inboxes i ON i.id = w.inbox_id
  WHERE w.inbox_id = NEW.inbox_id AND w.enabled = 1 AND i.active = 1;
END;
