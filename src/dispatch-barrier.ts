import type { Env } from "./types";

/** Raise both projections atomically so delayed writes from a previous actor cannot win after preparation. */
export async function webhookDispatchBarrier(
  env: Env,
  inbox: string,
  webhook: string,
  version: number,
): Promise<boolean> {
  const result = await env.DB.batch([
    env.DB.prepare(`UPDATE inboxes SET active_version = ? WHERE id = ? AND active = 1 AND active_version < ?
      AND EXISTS (SELECT 1 FROM inbox_webhooks WHERE inbox_id = ? AND id = ? AND enabled = 1) RETURNING id`).bind(
      version,
      inbox,
      version,
      inbox,
      webhook,
    ),
    env.DB.prepare(`UPDATE inbox_webhooks SET version = ? WHERE inbox_id = ? AND id = ? AND enabled = 1 AND version < ?
      AND EXISTS (SELECT 1 FROM inboxes WHERE id = ? AND active = 1 AND active_version = ?) RETURNING id`).bind(
      version,
      inbox,
      webhook,
      version,
      inbox,
      version,
    ),
  ]);
  return result.every((entry) => entry.results.length === 1);
}

export async function outboundDispatchBarrier(
  env: Env,
  inbox: string,
  version: number,
): Promise<boolean> {
  const row = await env.DB.prepare(
    "UPDATE inboxes SET active_version = ? WHERE id = ? AND active = 1 AND active_version < ? RETURNING id",
  )
    .bind(version, inbox, version)
    .first<{ id: string }>();
  return row !== null;
}
