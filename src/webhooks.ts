import { coordinator } from "./coordinator";
import { publishJobs } from "./queue-jobs";
import type { Env } from "./types";

export async function deliverWebhook(env: Env, id: string): Promise<void> {
  const row = await env.DB.prepare("SELECT inbox_id FROM webhook_deliveries WHERE id = ?")
    .bind(id)
    .first<{ inbox_id: string }>();
  if (row) await coordinator(env, row.inbox_id).deliverWebhook(id, row.inbox_id);
}
export async function republishWebhooks(env: Env): Promise<void> {
  const now = Date.now();
  const rows =
    await env.DB.prepare(`SELECT id, available_at AS due_at FROM webhook_deliveries WHERE status = 'pending' AND available_at <= ?
    UNION ALL SELECT id, updated_at AS due_at FROM webhook_deliveries WHERE status = 'sending' AND updated_at < ?
    ORDER BY due_at, id LIMIT 100`)
      .bind(now, now - 120_000)
      .all<{ id: string }>();
  await publishJobs(
    env.AGENTPOST_WEBHOOK_JOBS,
    rows.results.map((row) => ({ kind: "webhook", id: row.id })),
  );
}
