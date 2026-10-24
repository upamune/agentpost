ALTER TABLE inboxes ADD COLUMN owner_id TEXT;
CREATE INDEX inboxes_owner ON inboxes(owner_id, created_at DESC, id DESC);
