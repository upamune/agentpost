import { Hono } from "hono";
import type { Context } from "hono";
import PostalMime from "postal-mime";
import { z } from "zod";
import { authenticate } from "./auth";
import { equalHash, MAX_REQUEST_BYTES, randomToken, readBounded, sha256 } from "./common";
import { enqueue } from "./inbound";
import { eventDescriptors, eventQuerySchema } from "./event-schema";
import { EventQueryError, pollEvents } from "./events";
import type { Env, Inbox, Message, Outbox, SendPayload } from "./types";

type Bindings = { Bindings: Env; Variables: { admin: boolean; tokenHash: string; inbox: Inbox } };
const app = new Hono<Bindings>();
const noNewlines = z.string().refine((value) => !/[\r\n]/.test(value));
const address = z.email().max(254);
const sendInput = z
  .object({
    to: z.array(address).min(1).max(50),
    subject: noNewlines.pipe(z.string().max(998)),
    text: z.string().min(1).max(200_000),
    html: z.string().max(200_000).optional(),
  })
  .strict();
const replyInput = sendInput.omit({ to: true, subject: true });
const inboxInput = z.object({ label: z.string().max(100).default("") }).strict();
const pageInput = z.object({ limit: z.coerce.number().int().min(1).max(100).default(25) });

app.use("*", async (context, next) => {
  await next();
  context.header("Cache-Control", "no-store");
  context.header("X-Content-Type-Options", "nosniff");
  context.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
});

app.get("/healthz", (context) => context.json({ status: "ok" }));

app.use("/v1/*", async (context, next) => {
  const principal = await authenticate(context.env, context.req.header("Authorization"));
  if (principal instanceof Response) return principal;
  context.set("admin", principal.admin);
  context.set("tokenHash", principal.tokenHash);
  await next();
});

async function readJson<T>(context: Context<Bindings>, schema: z.ZodType<T>): Promise<T> {
  if (!context.req.header("Content-Type")?.toLowerCase().startsWith("application/json")) {
    throw new ApiError(415, "Content-Type must be application/json");
  }
  const stream = context.req.raw.body;
  const raw = stream ? await readBounded(stream, MAX_REQUEST_BYTES) : new ArrayBuffer(0);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    throw new ApiError(400, "Invalid JSON");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError(400, "Invalid input", parsed.error.flatten());
  return parsed.data;
}

class ApiError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 503,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

function requireAdmin(context: Context<Bindings>): void {
  if (!context.get("admin")) throw new ApiError(403, "Admin token required");
}

app.get("/v1/events", (context) => context.json({ events: eventDescriptors }));

app.post("/v1/events/poll", async (context) => {
  const query = await readJson(context, eventQuerySchema);
  const principal = await authenticate(context.env, context.req.header("Authorization"));
  if (principal instanceof Response) return principal;
  return context.json(await pollEvents(context.env, principal, query));
});

app.post("/v1/inboxes", async (context) => {
  requireAdmin(context);
  const input = await readJson(context, inboxInput);
  const domain = context.env.EMAIL_DOMAIN.toLowerCase();
  if (!z.hostname().safeParse(domain).success || !domain.includes("."))
    throw new ApiError(503, "Invalid EMAIL_DOMAIN");
  const id = crypto.randomUUID();
  const email = `${crypto.randomUUID().replaceAll("-", "")}@${domain}`;
  const token = randomToken();
  const now = Date.now();
  await context.env.DB.prepare(
    "INSERT INTO inboxes (id, address, label, token_hash, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(id, email, input.label, await sha256(token), now)
    .run();
  return context.json({ id, address: email, label: input.label, token, created_at: now }, 201);
});

app.get("/v1/inboxes", async (context) => {
  requireAdmin(context);
  const limit = Number(context.req.query("limit") ?? 25);
  const offset = Number(context.req.query("offset") ?? 0);
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  )
    throw new ApiError(400, "Invalid pagination");
  const rows = await context.env.DB.prepare(
    "SELECT id, address, label, active, created_at FROM inboxes ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
  )
    .bind(limit, offset)
    .all();
  return context.json({
    items: rows.results,
    next_offset: rows.results.length === limit ? offset + limit : null,
  });
});

app.get("/v1/health", async (context) => {
  requireAdmin(context);
  await context.env.MAIL.list({ limit: 1 });
  const totals = await context.env.DB.prepare(
    "SELECT (SELECT count(*) FROM outbox WHERE status = 'unknown' AND resolved_at IS NULL) AS unknown_sends, (SELECT count(*) FROM outbox WHERE status = 'failed' AND resolved_at IS NULL) AS failed_sends, (SELECT count(*) FROM messages WHERE status = 'failed') AS failed_messages, (SELECT min(created_at) FROM outbox WHERE status = 'pending') AS oldest_outbound, (SELECT min(created_at) FROM messages WHERE status = 'pending') AS oldest_inbound",
  ).first<{
    unknown_sends: number;
    failed_sends: number;
    failed_messages: number;
    oldest_outbound: number | null;
    oldest_inbound: number | null;
  }>();
  const sendConfigured = Boolean(context.env.CF_ACCOUNT_ID && context.env.CF_EMAIL_API_TOKEN);
  const stale = [totals?.oldest_outbound, totals?.oldest_inbound].some(
    (time) => time != null && time < Date.now() - 15 * 60_000,
  );
  const healthy =
    sendConfigured &&
    !stale &&
    totals?.unknown_sends === 0 &&
    totals.failed_sends === 0 &&
    totals.failed_messages === 0;
  return context.json(
    { status: healthy ? "ok" : "attention_required", send_configured: sendConfigured, ...totals },
    healthy ? 200 : 503,
  );
});

app.use("/v1/inboxes/:inbox/*", inboxAuth);
app.use("/v1/inboxes/:inbox", inboxAuth);

async function inboxAuth(context: Context<Bindings>, next: () => Promise<void>) {
  const inbox = await context.env.DB.prepare("SELECT * FROM inboxes WHERE id = ?")
    .bind(context.req.param("inbox"))
    .first<Inbox>();
  if (!inbox || (!context.get("admin") && !equalHash(inbox.token_hash, context.get("tokenHash"))))
    throw new ApiError(404, "Inbox not found");
  context.set("inbox", inbox);
  await next();
}

app.get("/v1/inboxes/:inbox", (context) => {
  const { token_hash: _secret, ...inbox } = context.get("inbox");
  return context.json(inbox);
});

app.patch("/v1/inboxes/:inbox", async (context) => {
  requireAdmin(context);
  const { active } = await readJson(context, z.object({ active: z.boolean() }).strict());
  await context.env.DB.prepare("UPDATE inboxes SET active = ? WHERE id = ?")
    .bind(active ? 1 : 0, context.get("inbox").id)
    .run();
  return context.json({ id: context.get("inbox").id, active });
});

app.post("/v1/inboxes/:inbox/token", async (context) => {
  requireAdmin(context);
  const token = randomToken();
  await context.env.DB.prepare("UPDATE inboxes SET token_hash = ? WHERE id = ?")
    .bind(await sha256(token), context.get("inbox").id)
    .run();
  return context.json({ id: context.get("inbox").id, token });
});

app.get("/v1/inboxes/:inbox/messages", async (context) => {
  const limit = Number(context.req.query("limit") ?? 25);
  const cursor = context.req.query("cursor");
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (cursor && !/^\d+:[a-f0-9]{64}$/.test(cursor))
  )
    throw new ApiError(400, "Invalid pagination");
  const [time, id] = cursor?.split(":") ?? [String(Number.MAX_SAFE_INTEGER), "~"];
  const rows = await context.env.DB.prepare(
    "SELECT id, envelope_from, envelope_to, subject, status, error, created_at FROM messages WHERE inbox_id = ? AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?",
  )
    .bind(context.get("inbox").id, Number(time), Number(time), id, limit)
    .all<Message>();
  const last = rows.results.at(-1);
  return context.json({
    items: rows.results,
    next_cursor: rows.results.length === limit && last ? `${last.created_at}:${last.id}` : null,
  });
});

async function findMessage(context: Context<Bindings>): Promise<Message> {
  const row = await context.env.DB.prepare("SELECT * FROM messages WHERE id = ? AND inbox_id = ?")
    .bind(context.req.param("message"), context.get("inbox").id)
    .first<Message>();
  if (!row) throw new ApiError(404, "Message not found");
  return row;
}

app.get("/v1/inboxes/:inbox/messages/:message", async (context) => {
  const row = await findMessage(context);
  const object = await context.env.MAIL.get(`parsed/${row.id}.json`);
  return context.json({ ...row, content: object ? await object.json() : null });
});

app.get("/v1/inboxes/:inbox/messages/:message/raw", async (context) => {
  const row = await findMessage(context);
  const object = await context.env.MAIL.get(row.raw_key);
  if (!object) throw new ApiError(503, "Original MIME unavailable");
  return new Response(object.body, {
    headers: {
      "Content-Type": "message/rfc822",
      "Content-Disposition": `attachment; filename="${row.id}.eml"`,
    },
  });
});

app.get("/v1/inboxes/:inbox/messages/:message/attachments/:index", async (context) => {
  const row = await findMessage(context);
  const index = Number(context.req.param("index"));
  if (!Number.isInteger(index) || index < 0) throw new ApiError(400, "Invalid attachment index");
  const object = await context.env.MAIL.get(row.raw_key);
  if (!object) throw new ApiError(503, "Original MIME unavailable");
  const parsed = await PostalMime.parse(await object.arrayBuffer());
  const attachment = parsed.attachments[index];
  if (!attachment) throw new ApiError(404, "Attachment not found");
  return new Response(attachment.content, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(attachment.filename ?? "attachment")}`,
    },
  });
});

app.post("/v1/inboxes/:inbox/messages/:message/reprocess", async (context) => {
  const row = await findMessage(context);
  await context.env.DB.prepare("UPDATE messages SET status = 'pending', error = NULL WHERE id = ?")
    .bind(row.id)
    .run();
  await enqueue(context.env, "inbound", row.id);
  return context.json({ id: row.id, status: "pending" }, 202);
});

async function queueSend(context: Context<Bindings>, payload: SendPayload) {
  const inbox = context.get("inbox");
  if (!inbox.active) throw new ApiError(409, "Inbox is disabled");
  const key = context.req.header("Idempotency-Key");
  if (!key || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(key))
    throw new ApiError(400, "Idempotency-Key header required (1-128 letters, digits, _, ., :, -)");
  const serialized = JSON.stringify(payload);
  const hash = await sha256(serialized);
  const now = Date.now();
  await context.env.DB.prepare(
    "INSERT OR IGNORE INTO outbox (id, inbox_id, idempotency_key, payload, payload_hash, available_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(crypto.randomUUID(), inbox.id, key, serialized, hash, now, now, now)
    .run();
  const row = await context.env.DB.prepare(
    "SELECT * FROM outbox WHERE inbox_id = ? AND idempotency_key = ?",
  )
    .bind(inbox.id, key)
    .first<Outbox>();
  if (!row) throw new Error("Outbox record not found after insert");
  if (row.payload_hash !== hash)
    throw new ApiError(409, "Idempotency-Key already used for different content");
  if (row.status === "pending") await enqueue(context.env, "outbound", row.id);
  return context.json(
    publicOutbox(row),
    row.status === "pending" || row.status === "sending" ? 202 : 200,
  );
}

app.post("/v1/inboxes/:inbox/send", async (context) => {
  const input = await readJson(context, sendInput);
  return queueSend(context, { from: context.get("inbox").address, ...input });
});

app.post("/v1/inboxes/:inbox/messages/:message/reply", async (context) => {
  const row = await findMessage(context);
  if (row.status !== "ready") throw new ApiError(409, "Message is not parsed yet");
  const input = await readJson(context, replyInput);
  const object = await context.env.MAIL.get(row.raw_key);
  if (!object) throw new ApiError(503, "Original MIME unavailable");
  const parsed = await PostalMime.parse(await object.arrayBuffer());
  const target = parsed.replyTo?.[0]?.address ?? parsed.from?.address ?? row.envelope_from;
  if (!address.safeParse(target).success)
    throw new ApiError(409, "Message has no valid reply address");
  const refs = `${parsed.references ?? ""} ${parsed.messageId ?? ""}`
    .match(/<[^<>\r\n]{1,250}>/g)
    ?.slice(-20)
    .join(" ");
  const messageId = parsed.messageId?.match(/^<[^<>\r\n]{1,250}>$/)?.[0];
  const headers: Record<string, string> = {};
  if (messageId) headers["In-Reply-To"] = messageId;
  if (refs) headers.References = refs;
  const subject = row.subject ?? "";
  return queueSend(context, {
    from: context.get("inbox").address,
    to: [target],
    subject: (/^re:/i.test(subject) ? subject : `Re: ${subject}`)
      .replace(/[\r\n]/g, " ")
      .slice(0, 998),
    ...input,
    ...(Object.keys(headers).length ? { headers } : {}),
  });
});

function publicOutbox(row: Outbox) {
  const { payload_hash: _hash, ...result } = row;
  return {
    ...result,
    payload: JSON.parse(row.payload),
    provider_result: row.provider_result ? JSON.parse(row.provider_result) : null,
  };
}

app.get("/v1/inboxes/:inbox/outbox/:send", async (context) => {
  const row = await context.env.DB.prepare("SELECT * FROM outbox WHERE id = ? AND inbox_id = ?")
    .bind(context.req.param("send"), context.get("inbox").id)
    .first<Outbox>();
  if (!row) throw new ApiError(404, "Send not found");
  return context.json(publicOutbox(row));
});

app.get("/v1/inboxes/:inbox/outbox", async (context) => {
  const parsed = pageInput.safeParse({ limit: context.req.query("limit") });
  if (!parsed.success) throw new ApiError(400, "Invalid pagination");
  const offset = Number(context.req.query("offset") ?? 0);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new ApiError(400, "Invalid offset");
  const rows = await context.env.DB.prepare(
    "SELECT * FROM outbox WHERE inbox_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
  )
    .bind(context.get("inbox").id, parsed.data.limit, offset)
    .all<Outbox>();
  return context.json({
    items: rows.results.map(publicOutbox),
    next_offset: rows.results.length === parsed.data.limit ? offset + parsed.data.limit : null,
  });
});

app.post("/v1/inboxes/:inbox/outbox/:send/resolve", async (context) => {
  requireAdmin(context);
  const input = await readJson(
    context,
    z
      .object({
        outcome: z.enum(["accepted", "failed"]),
        note: z.string().min(10).max(2000),
      })
      .strict(),
  );
  const row = await context.env.DB.prepare(
    "UPDATE outbox SET status = ?, resolution_note = ?, resolved_at = ?, updated_at = ? WHERE id = ? AND inbox_id = ? AND status IN ('unknown', 'failed') RETURNING *",
  )
    .bind(
      input.outcome,
      input.note,
      Date.now(),
      Date.now(),
      context.req.param("send"),
      context.get("inbox").id,
    )
    .first<Outbox>();
  if (!row) throw new ApiError(409, "Send not found or not awaiting reconciliation");
  console.log(JSON.stringify({ event: "outbound_reconciled", id: row.id, outcome: input.outcome }));
  return context.json(publicOutbox(row));
});

app.onError((error, context) => {
  if (error instanceof EventQueryError) return context.json({ error: error.message }, error.status);
  if (error instanceof ApiError)
    return context.json({ error: error.message, details: error.details }, error.status);
  if (error.message === "Message exceeds size limit")
    return context.json({ error: "Request body too large" }, 413);
  console.error(
    JSON.stringify({ event: "request_failed", path: new URL(context.req.url).pathname }),
  );
  return context.json(
    { error: "Internal error; retry send requests only with their original Idempotency-Key" },
    500,
  );
});

export default app;
