import { recoverForwarding } from "./forwarding";
import { republishWebhooks } from "./webhooks";
import { coordinator } from "./coordinator";
import { enqueue, repairRawIndex } from "./inbound";
import type { Env } from "./types";

export async function maintain(env: Env): Promise<void> {
  const results = await Promise.allSettled([
    recoverStaleSends(env),
    recoverForwarding(env),
    repairRawIndex(env),
    republishInbound(env),
    republishOutbound(env),
    republishWebhooks(env),
  ]);
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length) {
    console.error(JSON.stringify({ event: "maintenance_failed", failed_stages: errors.length }));
    throw new AggregateError(
      errors,
      "Scheduled recovery failed; independent recovery stages were still attempted",
    );
  }
}

async function recoverStaleSends(env: Env): Promise<void> {
  const now = Date.now();
  const stale = await env.DB.prepare(
    "SELECT id, inbox_id FROM outbox WHERE status = 'sending' AND updated_at < ? ORDER BY updated_at, id LIMIT 100",
  )
    .bind(now - 2 * 60_000)
    .all<{ id: string; inbox_id: string }>();
  const recovered = await Promise.allSettled(
    stale.results.map((row) => coordinator(env, row.inbox_id).recover(row.inbox_id, row.id)),
  );
  const errors = recovered.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (errors.length) throw new AggregateError(errors, "Stale-send recovery failed");
}

async function republishInbound(env: Env): Promise<void> {
  const inbound = await env.DB.prepare(
    "SELECT id FROM messages WHERE status = 'pending' ORDER BY created_at LIMIT 100",
  ).all<{ id: string }>();
  for (const row of inbound.results) await enqueue(env, "inbound", row.id);
}

async function republishOutbound(env: Env): Promise<void> {
  const now = Date.now();
  const outbound = await env.DB.prepare(
    "SELECT id FROM outbox WHERE status = 'pending' AND available_at <= ? ORDER BY created_at LIMIT 100",
  )
    .bind(now)
    .all<{ id: string }>();
  for (const row of outbound.results) await enqueue(env, "outbound", row.id);
}
