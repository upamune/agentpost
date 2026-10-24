CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  inbox_id TEXT NOT NULL REFERENCES inboxes(id),
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX events_inbox_seq ON events(inbox_id, seq);
CREATE INDEX events_name_seq ON events(name, seq);

-- Events and state transitions commit together. Reprocessing cannot emit duplicates.
CREATE TRIGGER message_received_event AFTER UPDATE OF status ON messages
WHEN NEW.status = 'ready' AND OLD.status != 'ready'
BEGIN
  INSERT OR IGNORE INTO events (id, name, inbox_id, data, created_at)
  VALUES (
    'message.received:' || NEW.id,
    'message.received',
    NEW.inbox_id,
    json_object('inbox_id', NEW.inbox_id, 'message_id', NEW.id),
    CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
  );
END;

CREATE TRIGGER send_status_event AFTER UPDATE OF status ON outbox
WHEN NEW.status IN ('accepted', 'failed', 'unknown') AND NEW.status != OLD.status
BEGIN
  INSERT OR IGNORE INTO events (id, name, inbox_id, data, created_at)
  VALUES (
    'message.send_status_changed:' || NEW.id || ':' || NEW.status || ':' || NEW.updated_at,
    'message.send_status_changed',
    NEW.inbox_id,
    json_object('inbox_id', NEW.inbox_id, 'send_id', NEW.id, 'status', NEW.status),
    CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
  );
END;
