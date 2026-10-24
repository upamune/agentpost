import { enqueue, repairRawIndex } from "./inbound";
import type { Env } from "./types";

export async function maintain(env: Env): Promise<void> {
  const results = await Promise.allSettled([
    recoverStaleSends(env),
    repairRawIndex(env),
    republishPending(env),
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
    "UPDATE outbox SET status = 'unknown', error = 'Worker stopped during send; check provider outcome before resending', updated_at = ? WHERE status = 'sending' AND updated_at < ? RETURNING id",
  )
    .bind(now, now - 2 * 60_000)
    .all<{ id: string }>();
  for (const row of stale.results) {
    console.error(
      JSON.stringify({ event: "outbound_attention_required", id: row.id, status: "unknown" }),
    );
  }
}

async function republishPending(env: Env): Promise<void> {
  const now = Date.now();
  const inbound = await env.DB.prepare(
    "SELECT id FROM messages WHERE status = 'pending' ORDER BY created_at LIMIT 100",
  ).all<{ id: string }>();
  for (const row of inbound.results) await enqueue(env, "inbound", row.id);
  const outbound = await env.DB.prepare(
    "SELECT id FROM outbox WHERE status = 'pending' AND available_at <= ? ORDER BY created_at LIMIT 100",
  )
    .bind(now)
    .all<{ id: string }>();
  for (const row of outbound.results) await enqueue(env, "outbound", row.id);
}
