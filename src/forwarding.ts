import { forwardingUnavailable, requireForwardDestination } from "./forwarding-policy";
import type { Env } from "./types";

async function blockForward(env: Env, id: string, reason: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE forwarding_deliveries SET status = 'blocked', error = ?, updated_at = ? WHERE message_id = ? AND status = 'pending'",
  )
    .bind(reason, Date.now(), id)
    .run();
}

async function pendingTarget(
  env: Env,
  id: string,
  message: ForwardableEmailMessage,
): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT destination FROM forwarding_deliveries WHERE message_id = ? AND status = 'pending'",
  )
    .bind(id)
    .first<{ destination: string | null }>();
  if (!row) return null;
  try {
    if (forwardingUnavailable(message) || message.headers.has("X-Agentpost-Forwarded"))
      throw new Error("Message cannot be forwarded");
    return requireForwardDestination(env, row.destination ?? "");
  } catch {
    await blockForward(env, id, "dispatch_policy_rejected");
    return null;
  }
}

export async function forwardReceived(
  env: Env,
  id: string,
  message: ForwardableEmailMessage,
): Promise<void> {
  const target = await pendingTarget(env, id, message);
  if (target === null) return;
  // Claim once, before the native call. No path resets an ambiguous claim to pending.
  const claimed =
    await env.DB.prepare(`UPDATE forwarding_deliveries SET status = 'sending', updated_at = ?
    WHERE message_id = ? AND destination = ? AND status = 'pending'
    AND EXISTS (SELECT 1 FROM inboxes WHERE id = forwarding_deliveries.inbox_id AND active = 1) RETURNING message_id`)
      .bind(Date.now(), id, target)
      .first();
  if (!claimed) {
    await blockForward(env, id, "inbox_disabled_before_claim");
    return;
  }
  let status = "accepted";
  let error: string | null = null;
  try {
    await message.forward(target, new Headers({ "X-Agentpost-Forwarded": "1" }));
  } catch {
    status = "unknown";
    error =
      "Native forwarding outcome unknown; inspect Cloudflare activity before any manual resend";
  }
  await env.DB.prepare(
    "UPDATE forwarding_deliveries SET status = ?, error = ?, updated_at = ? WHERE message_id = ? AND status = 'sending'",
  )
    .bind(status, error, Date.now(), id)
    .run();
}

export async function recoverForwarding(env: Env): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`UPDATE forwarding_deliveries SET status = 'unknown', error = 'SMTP handler ended during forwarding; inspect provider activity', updated_at = ?
      WHERE status = 'sending' AND message_id IN
      (SELECT message_id FROM forwarding_deliveries WHERE status = 'sending' AND updated_at < ? ORDER BY updated_at, message_id LIMIT 100)`).bind(
      now,
      now - 2 * 60_000,
    ),
    env.DB.prepare(`UPDATE forwarding_deliveries SET status = 'blocked', error = 'SMTP session unavailable; original retained for manual recovery', updated_at = ?
      WHERE status = 'pending' AND message_id IN
      (SELECT message_id FROM forwarding_deliveries WHERE status = 'pending' AND updated_at < ? ORDER BY updated_at, message_id LIMIT 100)`).bind(
      now,
      now - 2 * 60_000,
    ),
  ]);
}
