import { requireForwardDestination } from "./forwarding-policy";
import type { InboxForwardingInput } from "./forwarding-policy";
import type { Env, Inbox } from "./types";

export async function forwardingAdmission(env: Env, address: string) {
  return env.DB.prepare(`SELECT i.*,
    CASE WHEN f.mode = 'off' THEN NULL WHEN f.mode = 'custom' THEN f.destination ELSE g.destination END AS forward_destination
    FROM inboxes i LEFT JOIN inbox_forwarding f ON f.inbox_id = i.id
    LEFT JOIN forwarding_settings g ON g.id = 1 WHERE i.address = ? AND i.active = 1`)
    .bind(address.toLowerCase())
    .first<Inbox & { forward_destination: string | null }>();
}

export async function getGlobalForwarding(env: Env) {
  return (
    (await env.DB.prepare(
      "SELECT destination, updated_at FROM forwarding_settings WHERE id = 1",
    ).first<{ destination: string | null; updated_at: number }>()) ?? {
      destination: null,
      updated_at: 0,
    }
  );
}

export async function setGlobalForwarding(env: Env, destination: string | null) {
  const target = destination === null ? null : requireForwardDestination(env, destination);
  await env.DB.prepare(
    "UPDATE forwarding_settings SET destination = ?, updated_at = ? WHERE id = 1",
  )
    .bind(target, Date.now())
    .run();
  return getGlobalForwarding(env);
}

export async function getInboxForwarding(env: Env, inbox: string) {
  const row = await env.DB.prepare(`SELECT COALESCE(f.mode, 'inherit') AS mode, f.destination,
    CASE WHEN f.mode = 'off' THEN NULL WHEN f.mode = 'custom' THEN f.destination ELSE g.destination END AS effective_destination
    FROM inboxes i LEFT JOIN inbox_forwarding f ON f.inbox_id = i.id
    LEFT JOIN forwarding_settings g ON g.id = 1 WHERE i.id = ?`)
    .bind(inbox)
    .first<{
      mode: "inherit" | "off" | "custom";
      destination: string | null;
      effective_destination: string | null;
    }>();
  return row;
}

export async function setInboxForwarding(env: Env, inbox: string, input: InboxForwardingInput) {
  const destination =
    input.mode === "custom" ? requireForwardDestination(env, input.destination) : null;
  await env.DB.prepare(`INSERT INTO inbox_forwarding (inbox_id, mode, destination, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(inbox_id) DO UPDATE SET mode = excluded.mode, destination = excluded.destination, updated_at = excluded.updated_at`)
    .bind(inbox, input.mode, destination, Date.now())
    .run();
  return getInboxForwarding(env, inbox);
}

export async function indexForwarding(env: Env, meta: Record<string, string>): Promise<void> {
  if (meta.forward_version !== "1") return;
  const status = ["pending", "skipped", "blocked"].includes(meta.forward_status ?? "")
    ? meta.forward_status!
    : "blocked";
  await env.DB.prepare(`INSERT OR IGNORE INTO forwarding_deliveries
    (message_id, inbox_id, destination, status, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      meta.id,
      meta.inbox_id,
      meta.forward_destination || null,
      status,
      meta.forward_error || null,
      Number(meta.created_at),
      Number(meta.created_at),
    )
    .run();
}

export async function forwardingDeliveries(env: Env, inbox: string) {
  const rows =
    await env.DB.prepare(`SELECT message_id, destination, status, error, resolved_at, resolution_note, created_at, updated_at
    FROM forwarding_deliveries WHERE inbox_id = ? ORDER BY created_at DESC, message_id DESC LIMIT 50`)
      .bind(inbox)
      .all();
  return { deliveries: rows.results };
}

export async function resolveForwarding(env: Env, inbox: string, message: string, note: string) {
  const row =
    await env.DB.prepare(`UPDATE forwarding_deliveries SET resolved_at = ?, resolution_note = ?
    WHERE message_id = ? AND inbox_id = ? AND status IN ('blocked','unknown') AND resolved_at IS NULL RETURNING message_id`)
      .bind(Date.now(), note, message, inbox)
      .first<{ message_id: string }>();
  return row;
}
