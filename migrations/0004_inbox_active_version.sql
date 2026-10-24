-- Reject delayed writes from an older coordinator instance after handoff.
ALTER TABLE inboxes ADD COLUMN active_version INTEGER NOT NULL DEFAULT 0;
