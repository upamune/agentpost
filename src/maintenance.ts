import { recoverForwarding } from "./forwarding";
import { republishWebhooks } from "./webhooks";
import { coordinator } from "./coordinator";
import { repairRawIndex } from "./inbound";
import { publishJobs } from "./queue-jobs";
import type { Env } from "./types";

export async function maintain(env: Env): Promise<void> {
  const stages = {
    stale_sends: () => recoverStaleSends(env),
    forwarding: () => recoverForwarding(env),
    raw_index: () => repairRawIndex(env),
    inbound: () => republishInbound(env),
    outbound: () => republishOutbound(env),
    webhooks: () => republishWebhooks(env),
  };
  const names = Object.keys(stages);
  const results = await Promise.allSettled(Object.values(stages).map((stage) => stage()));
  const failures = results.flatMap((result, index) =>
    result.status === "rejected" ? [{ stage: names[index], error: result.reason }] : [],
  );
  if (failures.length) {
    console.error(
      JSON.stringify({
        event: "maintenance_failed",
        failed_stages: failures.length,
        stages: failures.map((failure) => failure.stage),
      }),
    );
    throw new AggregateError(
      failures.map((failure) => failure.error),
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
    "SELECT id FROM messages WHERE status = 'pending' ORDER BY created_at, id LIMIT 100",
  ).all<{ id: string }>();
  await publishJobs(
    env.JOBS,
    inbound.results.map((row) => ({ kind: "inbound", id: row.id })),
  );
}

async function republishOutbound(env: Env): Promise<void> {
  const now = Date.now();
  const outbound = await env.DB.prepare(
    "SELECT id FROM outbox WHERE status = 'pending' AND available_at <= ? ORDER BY available_at, created_at, id LIMIT 100",
  )
    .bind(now)
    .all<{ id: string }>();
  await publishJobs(
    env.JOBS,
    outbound.results.map((row) => ({ kind: "outbound", id: row.id })),
  );
}
