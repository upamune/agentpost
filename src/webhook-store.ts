import { readWebhookConfig } from "./webhook-crypto";
import type { Env } from "./types";

export interface WebhookRow {
  inbox_id: string;
  id: string;
  version: number;
  enabled: number;
  encrypted_config: string | null;
  created_at: number;
  updated_at: number;
}
export interface WebhookDelivery {
  id: string;
  inbox_id: string;
  webhook_id: string;
  message_id: string;
  status: "pending" | "sending" | "delivered" | "failed" | "cancelled";
  attempts: number;
  claim_token: string | null;
  available_at: number;
  http_status: number | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

export async function publicWebhook(env: Env, inbox: string) {
  const row = await env.DB.prepare("SELECT * FROM inbox_webhooks WHERE inbox_id = ?")
    .bind(inbox)
    .first<WebhookRow>();
  if (!row) return { inbox_id: inbox, enabled: false };
  const metadata = {
    inbox_id: inbox,
    id: row.id,
    version: row.version,
    enabled: row.enabled === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (!row.enabled || !row.encrypted_config) return metadata;
  const config = await readWebhookConfig(env, inbox, row.id, row.encrypted_config);
  return { ...metadata, url: config.url };
}

export async function saveWebhook(
  env: Env,
  inbox: string,
  id: string,
  encrypted: string | null,
  version: number,
): Promise<boolean> {
  const now = Date.now();
  const enabled = encrypted === null ? 0 : 1;
  const results = await env.DB.batch([
    env.DB.prepare(`INSERT INTO inbox_webhooks (inbox_id, id, version, enabled, encrypted_config, created_at, updated_at)
      SELECT id, ?, ?, ?, ?, ?, ? FROM inboxes WHERE id = ? AND (? = 0 OR active = 1)
      ON CONFLICT(inbox_id) DO UPDATE SET id = excluded.id, version = excluded.version, enabled = excluded.enabled,
        encrypted_config = excluded.encrypted_config, updated_at = excluded.updated_at
      WHERE inbox_webhooks.version < excluded.version RETURNING id`).bind(
      id,
      version,
      enabled,
      encrypted,
      now,
      now,
      inbox,
      enabled,
    ),
    env.DB.prepare(`UPDATE webhook_deliveries SET status = 'cancelled', claim_token = NULL, error = 'Webhook configuration replaced or removed', updated_at = ?
      WHERE inbox_id = ? AND status IN ('pending','sending') AND NOT EXISTS
      (SELECT 1 FROM inbox_webhooks w WHERE w.inbox_id = webhook_deliveries.inbox_id AND w.id = webhook_deliveries.webhook_id AND w.enabled = 1)`).bind(
      now,
      inbox,
    ),
  ]);
  return results[0]!.results.length === 1;
}

export async function enqueueWebhook(env: Env, id: string, delaySeconds = 0): Promise<void> {
  try {
    await env.AGENTPOST_WEBHOOK_JOBS.send({ kind: "webhook", id }, { delaySeconds });
  } catch {
    console.error(JSON.stringify({ event: "webhook_publish_failed", id }));
    throw new Error("Webhook queue publication failed; durable delivery retained");
  }
}

export async function publishMessageWebhooks(env: Env, message: string): Promise<void> {
  const rows = await env.DB.prepare(
    "SELECT id FROM webhook_deliveries WHERE message_id = ? AND status = 'pending'",
  )
    .bind(message)
    .all<{ id: string }>();
  for (const row of rows.results) await enqueueWebhook(env, row.id);
}
