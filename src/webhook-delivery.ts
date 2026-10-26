import type { Env } from "./types";
import { readWebhookConfig } from "./webhook-crypto";
import { webhookSignature } from "./webhook-crypto";
import { webhookTarget } from "./webhook-policy";
import { enqueueWebhook } from "./webhook-store";
import type { WebhookDelivery } from "./webhook-store";

const STALE_MS = 120_000;
const MAX_ATTEMPTS = 8;

async function claim(env: Env, id: string, inbox: string): Promise<WebhookDelivery | null> {
  const now = Date.now();
  await env.DB.prepare(
    "UPDATE webhook_deliveries SET status = CASE WHEN attempts >= 8 THEN 'failed' ELSE 'pending' END, error = 'Webhook request interrupted; retry limit enforced', claim_token = NULL WHERE id = ? AND inbox_id = ? AND status = 'sending' AND updated_at < ?",
  )
    .bind(id, inbox, now - STALE_MS)
    .run();
  return env.DB.prepare(
    "UPDATE webhook_deliveries SET status = 'sending', claim_token = ?, attempts = attempts + 1, updated_at = ? WHERE id = ? AND inbox_id = ? AND status = 'pending' AND available_at <= ? AND attempts < ? RETURNING *",
  )
    .bind(crypto.randomUUID(), now, id, inbox, now, MAX_ATTEMPTS)
    .first<WebhookDelivery>();
}

async function prepare(env: Env, row: WebhookDelivery): Promise<Request | null> {
  const config =
    await env.DB.prepare(`SELECT w.encrypted_config FROM inbox_webhooks w JOIN inboxes i ON i.id = w.inbox_id
    WHERE w.inbox_id = ? AND w.id = ? AND w.enabled = 1 AND i.active = 1`)
      .bind(row.inbox_id, row.webhook_id)
      .first<{ encrypted_config: string }>();
  if (!config) return null;
  const decoded = await readWebhookConfig(
    env,
    row.inbox_id,
    row.webhook_id,
    config.encrypted_config,
  );
  const target = webhookTarget(env, decoded.url);
  const body = JSON.stringify({
    event_id: `message.received:${row.message_id}`,
    type: "message.received",
    timestamp: new Date(row.created_at).toISOString(),
    data: { inbox_id: row.inbox_id, message_id: row.message_id },
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await webhookSignature(decoded.secret, row.id, timestamp, body);
  return new Request(target, {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
    headers: {
      "Content-Type": "application/json",
      "webhook-id": row.id,
      "webhook-timestamp": timestamp,
      "webhook-signature": signature,
    },
    body,
  });
}

type Outcome = {
  status: "delivered" | "pending" | "failed" | "cancelled";
  httpStatus: number | null;
  error: string | null;
  delay: number;
};
const cancelled = (): Outcome => ({
  status: "cancelled",
  httpStatus: null,
  error: "Webhook or inbox is disabled or replaced",
  delay: 0,
});
function retry(row: WebhookDelivery, httpStatus: number | null): Outcome {
  const exhausted = row.attempts >= MAX_ATTEMPTS;
  return {
    status: exhausted ? "failed" : "pending",
    httpStatus,
    error: exhausted ? "Webhook retry limit reached" : "Webhook request failed; retry scheduled",
    delay: Math.min(3600, 30 * 2 ** (row.attempts - 1)),
  };
}
function responseOutcome(row: WebhookDelivery, status: number): Outcome {
  if (status >= 200 && status < 300)
    return { status: "delivered", httpStatus: status, error: null, delay: 0 };
  if ([408, 425, 429].includes(status) || status >= 500) return retry(row, status);
  return {
    status: "failed",
    httpStatus: status,
    error: "Webhook endpoint rejected the request; inspect receiver configuration",
    delay: 0,
  };
}
async function dispatch(
  request: Request,
  row: WebhookDelivery,
  beforeDispatch: () => void,
): Promise<Outcome> {
  // Must remain outside the network catch: a failed ownership fence must never become a retryable request.
  beforeDispatch();
  try {
    const response = await fetch(request);
    void response.body?.cancel().catch(() => {});
    return responseOutcome(row, response.status);
  } catch {
    return retry(row, null);
  }
}
async function settle(env: Env, row: WebhookDelivery, outcome: Outcome): Promise<void> {
  const now = Date.now();
  const updated = await env.DB.prepare(
    "UPDATE webhook_deliveries SET status = ?, http_status = ?, error = ?, available_at = ?, updated_at = ?, claim_token = NULL WHERE id = ? AND inbox_id = ? AND status = 'sending' AND claim_token = ? RETURNING id",
  )
    .bind(
      outcome.status,
      outcome.httpStatus,
      outcome.error,
      now + outcome.delay * 1000,
      now,
      row.id,
      row.inbox_id,
      row.claim_token,
    )
    .first<{ id: string }>();
  if (updated && outcome.status === "pending") await enqueueWebhook(env, row.id, outcome.delay);
}
export async function processWebhook(
  env: Env,
  id: string,
  inbox: string,
  beforeDispatch: () => void,
  reserveDispatch: (webhook: string) => Promise<boolean>,
): Promise<void> {
  const row = await claim(env, id, inbox);
  if (!row) return;
  // Configuration/key errors leave the durable claim for scheduled recovery; no receiver data is logged.
  const request = await prepare(env, row);
  const authorized = request && (await reserveDispatch(row.webhook_id));
  const outcome = authorized ? await dispatch(request, row, beforeDispatch) : cancelled();
  await settle(env, row, outcome);
}
