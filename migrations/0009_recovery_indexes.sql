-- Match bounded recovery filtering/ordering and preserve status-prefix lookups.
CREATE INDEX inboxes_created ON inboxes(created_at DESC, id DESC);
DROP INDEX events_inbox_seq;
CREATE INDEX events_inbox_name_seq ON events(inbox_id, name, seq);
DROP INDEX messages_pending;
CREATE INDEX messages_pending ON messages(status, created_at, id);
DROP INDEX outbox_pending;
CREATE INDEX outbox_pending ON outbox(status, available_at, created_at, id);
CREATE INDEX outbox_recovery_sending ON outbox(status, updated_at, id);
CREATE INDEX webhook_recovery_sending ON webhook_deliveries(status, updated_at, id);
DROP INDEX webhook_deliveries_due;
CREATE INDEX webhook_deliveries_due ON webhook_deliveries(status, available_at, id);
-- Ready-mail publication previously scanned every delivery for each message.
CREATE INDEX webhook_delivery_message ON webhook_deliveries(message_id, status, id);
-- Health/configuration lookups join by captured webhook identity.
CREATE INDEX webhook_delivery_config ON webhook_deliveries(webhook_id, status);
DROP INDEX forwarding_attention;
CREATE INDEX forwarding_attention ON forwarding_deliveries(status, updated_at, message_id);
-- Refresh planner statistics after changing indexes (Cloudflare D1 guidance).
PRAGMA optimize;
