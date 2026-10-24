import { z } from "zod";
import type { Principal } from "./auth";
import { equalHash, sha256 } from "./common";
import { EVENT_NAMES } from "./event-schema";
import type { EventPollPage, EventQuery } from "./event-schema";
import type { Env } from "./types";

interface StoredEvent {
  seq: number;
  id: string;
  name: (typeof EVENT_NAMES)[number];
  data: string;
  created_at: number;
}
const cursorSchema = z
  .object({ v: z.literal(1), seq: z.number().int().nonnegative().safe(), scope: z.string() })
  .strict();

export class EventQueryError extends Error {
  constructor(
    public status: 400 | 403 | 404,
    message: string,
  ) {
    super(message);
  }
}

function encode(value: string): string {
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function signature(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const result = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(result), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function makeCursor(env: Env, scope: string, seq: number): Promise<string> {
  const value = encode(JSON.stringify({ v: 1, seq, scope }));
  return `${value}.${await signature(env.AGENTPOST_ADMIN_TOKEN, value)}`;
}

async function readCursor(env: Env, scope: string, value: string): Promise<number> {
  try {
    const [encoded, mac, extra] = value.split(".");
    if (
      extra ||
      !encoded ||
      !/^[a-f0-9]{64}$/.test(mac) ||
      !equalHash(mac, await signature(env.AGENTPOST_ADMIN_TOKEN, encoded))
    )
      throw new Error("Invalid signature");
    const parsed = cursorSchema.parse(
      JSON.parse(atob(encoded.replaceAll("-", "+").replaceAll("_", "/"))),
    );
    if (parsed.scope !== scope) throw new Error("Wrong scope");
    return parsed.seq;
  } catch {
    throw new EventQueryError(
      400,
      "Invalid event cursor or cursor belongs to another subscription",
    );
  }
}

export async function pollEvents(
  env: Env,
  principal: Principal,
  query: EventQuery,
): Promise<EventPollPage> {
  if (!EVENT_NAMES.some((name) => name === query.name))
    throw new EventQueryError(404, "Event type not found");
  if (
    !principal.admin &&
    query.arguments.inbox_id &&
    query.arguments.inbox_id !== principal.inboxId
  ) {
    throw new EventQueryError(403, "Subscription is outside the token's inbox scope");
  }
  const inboxId = query.arguments.inbox_id ?? principal.inboxId;
  if (inboxId) {
    const inbox = await env.DB.prepare("SELECT id FROM inboxes WHERE id = ? AND active = 1")
      .bind(inboxId)
      .first();
    if (!inbox) throw new EventQueryError(403, "Inbox is disabled or unavailable");
  }
  const scope = await sha256(
    JSON.stringify({ principal: principal.tokenHash, name: query.name, inboxId }),
  );
  const head =
    (
      await env.DB.prepare("SELECT coalesce(max(seq), 0) AS seq FROM events").first<{
        seq: number;
      }>()
    )?.seq ?? 0;
  if (query.cursor == null) {
    const cursor = await makeCursor(env, scope, head);
    return {
      events: [],
      cursor,
      startCursor: cursor,
      eventCursors: [],
      truncated: false,
      hasMore: false,
      nextPollMs: 5000,
    };
  }
  let position = await readCursor(env, scope, query.cursor);
  // A cursor ahead of the database indicates restore/reset: report a gap rather than skip forever.
  let truncated = position > head;
  if (truncated) position = head;
  const floor = query.maxAgeMs === undefined ? null : Date.now() - query.maxAgeMs;
  if (floor !== null) {
    const skipped = await env.DB.prepare(
      "SELECT 1 FROM events WHERE seq > ? AND seq <= ? AND name = ? AND (? IS NULL OR inbox_id = ?) AND created_at < ? LIMIT 1",
    )
      .bind(position, head, query.name, inboxId, inboxId, floor)
      .first();
    truncated ||= Boolean(skipped);
  }
  const rows = await env.DB.prepare(
    "SELECT seq, id, name, data, created_at FROM events WHERE seq > ? AND seq <= ? AND name = ? AND (? IS NULL OR inbox_id = ?) AND (? IS NULL OR created_at >= ?) ORDER BY seq LIMIT ?",
  )
    .bind(position, head, query.name, inboxId, inboxId, floor, floor, query.maxEvents + 1)
    .all<StoredEvent>();
  const hasMore = rows.results.length > query.maxEvents;
  const delivered = rows.results.slice(0, query.maxEvents);
  const watermark = hasMore ? delivered[delivered.length - 1].seq : head;
  return {
    events: delivered.map((row) => ({
      eventId: row.id,
      name: row.name,
      timestamp: new Date(row.created_at).toISOString(),
      data: JSON.parse(row.data),
    })),
    cursor: await makeCursor(env, scope, watermark),
    startCursor: await makeCursor(env, scope, position),
    eventCursors: await Promise.all(delivered.map((row) => makeCursor(env, scope, row.seq))),
    truncated,
    hasMore,
    nextPollMs: 5000,
  };
}
