import { canAccessInbox } from "./auth";
import type { Principal } from "./auth";
import { authConfiguration } from "./auth-config";
import { equalHash, sha256 } from "./common";
import { EVENT_NAMES } from "./event-schema";
import type { EventPollPage, EventQuery } from "./event-schema";
import type { Env, Inbox } from "./types";

interface StoredEvent {
  seq: number;
  id: string;
  name: (typeof EVENT_NAMES)[number];
  data: string;
  created_at: number;
}
const CURSOR_CONTEXT = new TextEncoder().encode("agentpost:events:cursor:v2");
const CURSOR_PLAINTEXT_BYTES = 8 + 32;
const CURSOR_IV_BYTES = 12;
const CURSOR_BYTES = CURSOR_IV_BYTES + CURSOR_PLAINTEXT_BYTES + 16;

export class EventQueryError extends Error {
  constructor(
    public status: 400 | 403 | 404,
    message: string,
  ) {
    super(message);
  }
}

function encode(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

async function cursorKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`agentpost:events:cursor:v2:key\0${secret}`),
  );
  return crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function makeCursor(env: Env, scope: string, seq: number): Promise<string> {
  if (!Number.isSafeInteger(seq) || seq < 0 || !/^[a-f0-9]{64}$/.test(scope))
    throw new Error("Invalid event cursor state");
  // Fixed-size plaintext conceals global sequence values, including their digit count.
  const plaintext = new Uint8Array(CURSOR_PLAINTEXT_BYTES);
  new DataView(plaintext.buffer).setBigUint64(0, BigInt(seq));
  for (let index = 0; index < 32; index++)
    plaintext[8 + index] = Number.parseInt(scope.slice(index * 2, index * 2 + 2), 16);
  const iv = crypto.getRandomValues(new Uint8Array(CURSOR_IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: CURSOR_CONTEXT, tagLength: 128 },
    await cursorKey(authConfiguration(env).cursorKey),
    plaintext,
  );
  const value = new Uint8Array(CURSOR_BYTES);
  value.set(iv);
  value.set(new Uint8Array(ciphertext), CURSOR_IV_BYTES);
  return `v2.${encode(value)}`;
}

async function readCursor(env: Env, scope: string, value: string): Promise<number> {
  try {
    const bytes = decodeCursor(value);
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: bytes.slice(0, CURSOR_IV_BYTES),
        additionalData: CURSOR_CONTEXT,
        tagLength: 128,
      },
      await cursorKey(authConfiguration(env).cursorKey),
      bytes.slice(CURSOR_IV_BYTES),
    );
    if (plaintext.byteLength !== CURSOR_PLAINTEXT_BYTES) throw new Error("Invalid cursor length");
    const seq = new DataView(plaintext).getBigUint64(0);
    const actualScope = Array.from(new Uint8Array(plaintext, 8), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    if (seq > BigInt(Number.MAX_SAFE_INTEGER) || !equalHash(actualScope, scope))
      throw new Error("Invalid cursor scope or position");
    return Number(seq);
  } catch {
    throw new EventQueryError(
      400,
      "Invalid event cursor or cursor belongs to another subscription",
    );
  }
}

function decodeCursor(value: string): Uint8Array {
  // Legacy readable cursors and noncanonical encodings require an explicit restart.
  const encoded = /^v2\.([a-zA-Z0-9_-]{91})$/.exec(value)?.[1];
  if (!encoded) throw new Error("Invalid cursor encoding");
  const bytes = Uint8Array.from(
    atob(`${encoded.replaceAll("-", "+").replaceAll("_", "/")}=`),
    (character) => character.charCodeAt(0),
  );
  if (bytes.length !== CURSOR_BYTES || encode(bytes) !== encoded)
    throw new Error("Noncanonical cursor encoding");
  return bytes;
}

function subscriptionInbox(principal: Principal, query: EventQuery): string | null {
  const inboxId = query.arguments.inbox_id ?? principal.inboxId;
  if (principal.admin) return inboxId;
  if (principal.credential === "token") {
    assertTokenSubscription(principal, query.arguments.inbox_id);
  } else if (principal.credential === "oauth" && !inboxId) {
    throw new EventQueryError(403, "OAuth agents must select an owned inbox");
  }
  return inboxId;
}

function assertTokenSubscription(principal: Principal, requested: string | undefined): void {
  if (requested && requested !== principal.inboxId)
    throw new EventQueryError(403, "Subscription is outside the token's inbox scope");
}

async function authorizeSubscription(env: Env, principal: Principal, query: EventQuery) {
  if (!EVENT_NAMES.some((name) => name === query.name))
    throw new EventQueryError(404, "Event type not found");
  const inboxId = subscriptionInbox(principal, query);
  if (inboxId) {
    const inbox = await env.DB.prepare("SELECT * FROM inboxes WHERE id = ? AND active = 1")
      .bind(inboxId)
      .first<Inbox>();
    if (!inbox || !canAccessInbox(principal, inbox))
      throw new EventQueryError(403, "Inbox is disabled or unavailable");
  }
  return inboxId;
}

async function eventHead(env: Env): Promise<number> {
  return (
    (
      await env.DB.prepare("SELECT coalesce(max(seq), 0) AS seq FROM events").first<{
        seq: number;
      }>()
    )?.seq ?? 0
  );
}

function eventInboxFilter(inbox: string | null) {
  return inbox === null ? { sql: "", values: [] } : { sql: " AND inbox_id = ?", values: [inbox] };
}

export async function pollEvents(
  env: Env,
  principal: Principal,
  query: EventQuery,
): Promise<EventPollPage> {
  const inboxId = await authorizeSubscription(env, principal, query);
  const inboxFilter = eventInboxFilter(inboxId);
  const scope = await sha256(
    JSON.stringify({ principal: principal.tokenHash, name: query.name, inboxId }),
  );
  const head = await eventHead(env);
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
      `SELECT 1 FROM events WHERE seq > ? AND seq <= ? AND name = ?${inboxFilter.sql} AND created_at < ? LIMIT 1`,
    )
      .bind(position, head, query.name, ...inboxFilter.values, floor)
      .first();
    truncated ||= Boolean(skipped);
  }
  const rows = await env.DB.prepare(
    `SELECT seq, id, name, data, created_at FROM events WHERE seq > ? AND seq <= ? AND name = ?${inboxFilter.sql} AND (? IS NULL OR created_at >= ?) ORDER BY seq LIMIT ?`,
  )
    .bind(position, head, query.name, ...inboxFilter.values, floor, floor, query.maxEvents + 1)
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
