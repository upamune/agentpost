import { mailboxLocalPart } from "./inbox-schema";
import { publicInbox } from "./inbox-metadata";
import type { Env, Inbox } from "./types";

const CATCHALL_MAINTENANCE_KEY = "catchall_inbox_id";
const DEFAULT_CATCHALL_LOCAL_PART = "_catchall";

export class CatchallError extends Error {
  constructor(
    public status: 409 | 503,
    message: string,
  ) {
    super(message);
  }
}

/** Inbox admitted for an unissued recipient. Forwarding is always disabled on this path. */
type CatchallAdmission = Inbox & { forward_destination: null; catchall: true };

function catchallLocalPart(env: Env): string {
  const parsed = mailboxLocalPart.safeParse(
    env.AGENTPOST_CATCHALL_LOCAL_PART ?? DEFAULT_CATCHALL_LOCAL_PART,
  );
  if (!parsed.success) throw new CatchallError(503, "Invalid AGENTPOST_CATCHALL_LOCAL_PART");
  return parsed.data.toLowerCase();
}

function recipientDomain(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1).toLowerCase();
}

/**
 * Route mail for an address that has no inbox record to the configured catch-all inbox.
 * Disabled inboxes keep their record and are never admitted here, so they still reject.
 * Unconfigured or disabled catch-all inboxes leave unknown recipients rejected.
 */
export async function catchallAdmission(
  env: Env,
  address: string,
): Promise<CatchallAdmission | null> {
  if (recipientDomain(address) !== env.AGENTPOST_EMAIL_DOMAIN.toLowerCase()) return null;
  const inbox = await env.DB.prepare(`SELECT i.* FROM maintenance m JOIN inboxes i ON i.id = m.value
    WHERE m.key = ? AND i.active = 1 AND NOT EXISTS (SELECT 1 FROM inboxes x WHERE x.address = ?)`)
    .bind(CATCHALL_MAINTENANCE_KEY, address.toLowerCase())
    .first<Inbox>();
  // Unknown mail must never inherit global or per-inbox forwarding.
  return inbox ? { ...inbox, forward_destination: null, catchall: true } : null;
}

export async function getCatchall(env: Env) {
  const row = await env.DB.prepare(`SELECT i.*, COALESCE(f.mode, 'inherit') AS forwarding_mode
    FROM maintenance m LEFT JOIN inboxes i ON i.id = m.value LEFT JOIN inbox_forwarding f ON f.inbox_id = i.id
    WHERE m.key = ?`)
    .bind(CATCHALL_MAINTENANCE_KEY)
    .first<Inbox & { forwarding_mode: string }>();
  if (!row) return { configured: false as const };
  if (!row.id) throw new CatchallError(503, "Catch-all configuration references a missing inbox");
  return {
    configured: true as const,
    inbox: publicInbox(row),
    forwarding: { mode: row.forwarding_mode },
  };
}

/**
 * Create the catch-all inbox once, record it in maintenance, and force its forwarding off.
 * One D1 batch keeps concurrent provisioning idempotent: only the first inbox is recorded.
 */
export async function provisionCatchall(
  env: Env,
  record: { id: string; tokenHash: string; now: number },
) {
  const address = `${catchallLocalPart(env)}@${env.AGENTPOST_EMAIL_DOMAIN.toLowerCase()}`;
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO inboxes (id, address, label, token_hash, created_at, owner_id, notes, urls_json)
      SELECT ?, ?, 'catch-all', ?, ?, NULL, 'Quarantine for mail sent to unissued addresses.', '[]'
      WHERE NOT EXISTS (SELECT 1 FROM maintenance WHERE key = ?)
      ON CONFLICT(address) DO NOTHING`).bind(
      record.id,
      address,
      record.tokenHash,
      record.now,
      CATCHALL_MAINTENANCE_KEY,
    ),
    env.DB.prepare(`INSERT INTO maintenance (key, value) SELECT ?, id FROM inboxes WHERE id = ?
      ON CONFLICT(key) DO NOTHING`).bind(CATCHALL_MAINTENANCE_KEY, record.id),
    env.DB.prepare(`INSERT INTO inbox_forwarding (inbox_id, mode, destination, updated_at)
      SELECT i.id, 'off', NULL, ? FROM maintenance m JOIN inboxes i ON i.id = m.value WHERE m.key = ?
      ON CONFLICT(inbox_id) DO UPDATE SET mode = 'off', destination = NULL, updated_at = excluded.updated_at
      WHERE inbox_forwarding.mode != 'off'`).bind(record.now, CATCHALL_MAINTENANCE_KEY),
  ]);
  const state = await getCatchall(env);
  if (!state.configured)
    throw new CatchallError(409, `Catch-all address ${address} is already used by another inbox`);
  return { ...state, created: state.inbox.id === record.id };
}
