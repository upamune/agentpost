import { resolveIdempotencyKey } from "./idempotency";
import { WebhookError, webhookInput, webhookTarget, webhookEncryptionKey } from "./webhook-policy";
import { publicWebhook } from "./webhook-store";
import type { WebhookDelivery } from "./webhook-store";
import { coordinator } from "./coordinator";
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { authenticate, canAccessInbox } from "./auth";
import type { Principal } from "./auth";
import { authConfiguration } from "./auth-config";
import { inboxInputSchema } from "./inbox-schema";
import { randomMailboxName } from "./mailbox-name";
import { MAX_REQUEST_BYTES, randomToken, readBounded, sha256 } from "./common";
import { enqueue, parseMime } from "./inbound";
import { eventDescriptors, eventQuerySchema } from "./event-schema";
import { EventQueryError, pollEvents } from "./events";
import { enforceRateLimit } from "./http-security";
import { checkDomain } from "./domain-check";
import type { Env, Inbox, Message, Outbox, StoredSendPayload } from "./types";

import {
  AttachmentError,
  attachmentIdsSchema,
  attachmentType,
  MAX_ATTACHMENT_BYTES,
} from "./attachment-policy";
import { uploadAttachment, validateOutgoingAttachments } from "./attachments";

type Bindings = { Bindings: Env; Variables: { principal: Principal; inbox: Inbox } };
const app = new Hono<Bindings>();
const headerText = z.string().refine((value) => !/\p{Cc}/u.test(value));
const address = z.email().max(254);
const sendInput = z
  .object({
    to: z.array(address).min(1).max(50),
    subject: headerText.pipe(z.string().max(998)),
    text: z.string().min(1).max(200_000),
    html: z.string().max(200_000).optional(),
    attachments: attachmentIdsSchema,
  })
  .strict();
const replyInput = sendInput.omit({ to: true, subject: true });
const pageInput = z.object({ limit: z.coerce.number().int().min(1).max(100).default(25) });

app.use("*", async (context, next) => {
  await next();
  context.header("Cache-Control", "no-store");
  context.header("X-Content-Type-Options", "nosniff");
  context.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
});

app.get("/healthz", (context) => context.json({ status: "ok" }));

app.use("/v1/*", async (context, next) => {
  const principal = await authenticate(context.env, context.req.raw);
  if (principal instanceof Response) return principal;
  context.set("principal", principal);
  await next();
});

async function readJson<T>(context: Context<Bindings>, schema: z.ZodType<T>): Promise<T> {
  requireJsonContentType(context);
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

function requireJsonContentType(context: Context<Bindings>): void {
  if (
    context.req.header("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() !==
    "application/json"
  ) {
    throw new ApiError(415, "Content-Type must be application/json");
  }
}

class ApiError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 429 | 503,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

function requireAdmin(context: Context<Bindings>): void {
  if (!context.get("principal").admin) throw new ApiError(403, "Administrator access required");
}

function mailDomain(env: Env): string {
  const domain = env.AGENTPOST_EMAIL_DOMAIN.toLowerCase();
  if (!z.hostname().safeParse(domain).success || !domain.includes("."))
    throw new ApiError(503, "Invalid AGENTPOST_EMAIL_DOMAIN");
  return domain;
}

function mailboxAddress(domain: string, input: z.output<typeof inboxInputSchema>): string {
  const localPart = input.local_part?.toLowerCase() ?? randomMailboxName();
  const email = `${localPart}@${domain}`;
  if (email.length > 254)
    throw new ApiError(
      input.local_part === undefined ? 503 : 400,
      "Email address exceeds 254 characters",
    );
  return email;
}

async function reserveInboxAddress(
  context: Context<Bindings>,
  input: z.output<typeof inboxInputSchema>,
  record: { id: string; tokenHash: string; now: number },
): Promise<string> {
  const domain = mailDomain(context.env);
  const attempts = input.local_part === undefined ? 8 : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const email = mailboxAddress(domain, input);
    const created = await context.env.DB.prepare(
      "INSERT INTO inboxes (id, address, label, token_hash, created_at, owner_id) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(address) DO NOTHING RETURNING id",
    )
      .bind(
        record.id,
        email,
        input.label,
        record.tokenHash,
        record.now,
        context.get("principal").ownerId ?? null,
      )
      .first<{ id: string }>();
    if (created) return email;
  }
  if (input.local_part !== undefined) throw new ApiError(409, "Email address already exists");
  throw new ApiError(503, "Could not allocate a unique email address. Try again later.");
}

function pageLimit(value: string | undefined): number {
  const limit = Number(value ?? 25);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new ApiError(400, "Invalid pagination");
  return limit;
}

function inboxPagination(context: Context<Bindings>) {
  const limit = pageLimit(context.req.query("limit"));
  const offset = Number(context.req.query("offset") ?? 0);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new ApiError(400, "Invalid pagination");
  return { limit, offset };
}

app.get("/v1/events", (context) => context.json({ events: eventDescriptors }));

app.post("/v1/events/poll", async (context) => {
  const query = await readJson(context, eventQuerySchema);
  return context.json(await pollEvents(context.env, context.get("principal"), query));
});

app.post("/v1/inboxes", async (context) => {
  const principal = context.get("principal");
  if (!principal.admin && !principal.ownerId)
    throw new ApiError(403, "Inbox provisioning forbidden");
  const input = await readJson(context, inboxInputSchema);
  const id = crypto.randomUUID();
  const token = randomToken();
  const now = Date.now();
  const email = await reserveInboxAddress(context, input, {
    id,
    tokenHash: await sha256(token),
    now,
  });
  return context.json(
    {
      id,
      address: email,
      label: input.label,
      ...(principal.credential === "token" ? { token } : {}),
      created_at: now,
    },
    201,
  );
});

app.get("/v1/inboxes", async (context) => {
  const principal = context.get("principal");
  if (!principal.admin && !principal.ownerId) throw new ApiError(403, "Inbox listing forbidden");
  const owner = principal.admin ? null : principal.ownerId!;
  const { limit, offset } = inboxPagination(context);
  const rows = await context.env.DB.prepare(
    "SELECT id, address, label, active, created_at FROM inboxes WHERE (? IS NULL OR owner_id = ?) ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
  )
    .bind(owner, owner, limit, offset)
    .all();
  return context.json({
    items: rows.results,
    next_offset: rows.results.length === limit ? offset + limit : null,
  });
});

app.get("/v1/domain/check", async (context) => {
  requireAdmin(context);
  return context.json(await checkDomain(context.env));
});

interface HealthTotals {
  unknown_sends: number;
  failed_sends: number;
  failed_messages: number;
  failed_webhooks: number;
  oldest_webhook: number | null;
  raw_recovery_failures: number;
  oldest_outbound: number | null;
  oldest_sending: number | null;
  oldest_inbound: number | null;
}
function noHealthFailures(totals: HealthTotals | null): boolean {
  if (!totals) return false;
  return [
    totals.unknown_sends,
    totals.failed_sends,
    totals.failed_messages,
    totals.failed_webhooks,
    totals.raw_recovery_failures,
  ].every((count) => count === 0);
}

function staleHealthTotals(totals: HealthTotals | null): boolean {
  return [
    totals?.oldest_outbound,
    totals?.oldest_sending,
    totals?.oldest_inbound,
    totals?.oldest_webhook,
  ].some((time) => time != null && time < Date.now() - 15 * 60_000);
}

app.get("/v1/health", async (context) => {
  requireAdmin(context);
  await context.env.MAIL.list({ limit: 1 });
  const totals = await context.env.DB.prepare(
    "SELECT (SELECT count(*) FROM outbox WHERE status = 'unknown' AND resolved_at IS NULL) AS unknown_sends, (SELECT count(*) FROM outbox WHERE status = 'failed' AND resolved_at IS NULL) AS failed_sends, (SELECT count(*) FROM messages WHERE status = 'failed') AS failed_messages, (SELECT count(*) FROM raw_recovery_failures) AS raw_recovery_failures, (SELECT min(created_at) FROM outbox WHERE status = 'pending') AS oldest_outbound, (SELECT min(updated_at) FROM outbox WHERE status = 'sending') AS oldest_sending, (SELECT min(created_at) FROM messages WHERE status = 'pending') AS oldest_inbound, (SELECT count(*) FROM webhook_deliveries d JOIN inbox_webhooks w ON w.id = d.webhook_id WHERE d.status = 'failed' AND w.enabled = 1) AS failed_webhooks, (SELECT min(created_at) FROM webhook_deliveries WHERE status IN ('pending','sending')) AS oldest_webhook",
  ).first<HealthTotals>();
  const sendConfigured = Boolean(
    context.env.AGENTPOST_CF_ACCOUNT_ID && context.env.AGENTPOST_CF_EMAIL_API_TOKEN,
  );
  const stale = staleHealthTotals(totals);
  const healthy = sendConfigured && !stale && noHealthFailures(totals);
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
  if (!inbox || !canAccessInbox(context.get("principal"), inbox))
    throw new ApiError(404, "Inbox not found");
  context.set("inbox", inbox);
  await next();
}

app.get("/v1/inboxes/:inbox", (context) => {
  const {
    token_hash: _secret,
    active_version: _version,
    owner_id: _owner,
    ...inbox
  } = context.get("inbox");
  return context.json(inbox);
});

app.patch("/v1/inboxes/:inbox", async (context) => {
  requireAdmin(context);
  const { active } = await readJson(context, z.object({ active: z.boolean() }).strict());
  await coordinator(context.env, context.get("inbox").id).setActive(
    context.get("inbox").id,
    active,
  );
  return context.json({ id: context.get("inbox").id, active });
});

app.get("/v1/inboxes/:inbox/webhook", async (context) =>
  context.json(await publicWebhook(context.env, context.get("inbox").id)),
);

app.put("/v1/inboxes/:inbox/webhook", async (context) => {
  const { url } = await readJson(context, webhookInput);
  webhookTarget(context.env, url);
  webhookEncryptionKey(context.env);
  if (!context.get("inbox").active) throw new ApiError(409, "Inbox is disabled");
  const result = await coordinator(context.env, context.get("inbox").id).setWebhook(
    context.get("inbox").id,
    url,
  );
  if (result.error) throw new ApiError(409, result.error);
  return context.json(result);
});
app.delete("/v1/inboxes/:inbox/webhook", async (context) => {
  const result = await coordinator(context.env, context.get("inbox").id).setWebhook(
    context.get("inbox").id,
    null,
  );
  if (result.error) throw new ApiError(409, result.error);
  return context.json(result);
});
app.get("/v1/inboxes/:inbox/webhook/deliveries", async (context) => {
  const rows = await context.env.DB.prepare(
    "SELECT id, inbox_id, webhook_id, message_id, status, attempts, available_at, http_status, error, created_at, updated_at FROM webhook_deliveries WHERE inbox_id = ? ORDER BY created_at DESC, id DESC LIMIT 50",
  )
    .bind(context.get("inbox").id)
    .all<Omit<WebhookDelivery, "claim_token">>();
  return context.json({ deliveries: rows.results });
});

app.post("/v1/inboxes/:inbox/token", async (context) => {
  requireAdmin(context);
  if (authConfiguration(context.env).mode === "oauth")
    throw new ApiError(409, "Token authentication is disabled");
  const token = randomToken();
  await context.env.DB.prepare("UPDATE inboxes SET token_hash = ? WHERE id = ?")
    .bind(await sha256(token), context.get("inbox").id)
    .run();
  return context.json({ id: context.get("inbox").id, token });
});

function messagePagination(context: Context<Bindings>) {
  const limit = pageLimit(context.req.query("limit"));
  const cursor = context.req.query("cursor");
  if (cursor && !/^\d+:[a-f0-9]{64}$/.test(cursor)) throw new ApiError(400, "Invalid pagination");
  const [time, id] = cursor?.split(":") ?? [String(Number.MAX_SAFE_INTEGER), "~"];
  return { limit, time: Number(time), id };
}

app.get("/v1/inboxes/:inbox/messages", async (context) => {
  const { limit, time, id } = messagePagination(context);
  const rows = await context.env.DB.prepare(
    "SELECT id, envelope_from, envelope_to, subject, status, error, created_at FROM messages WHERE inbox_id = ? AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?",
  )
    .bind(context.get("inbox").id, time, time, id, limit)
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
  const parsed = await parseMime(await object.arrayBuffer());
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

interface OutboxRequest {
  key: string;
  serialized: string;
  hash: string;
  now: number;
  payload: StoredSendPayload;
}

async function findOrCreateOutbox(context: Context<Bindings>, request: OutboxRequest) {
  const inbox = context.get("inbox");
  const { key, serialized, hash, now } = request;
  const find = () =>
    context.env.DB.prepare("SELECT * FROM outbox WHERE inbox_id = ? AND idempotency_key = ?")
      .bind(inbox.id, key)
      .first<Outbox>();
  const existing = await find();
  if (existing) return existing;
  const limited = await enforceRateLimit(context.env.AGENTPOST_SEND_LIMITER, `send:${inbox.id}`);
  if (limited) return limited;
  await validateOutgoingAttachments(context.env, inbox.id, request.payload);
  await context.env.DB.prepare(
    "INSERT OR IGNORE INTO outbox (id, inbox_id, idempotency_key, payload, payload_hash, available_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(crypto.randomUUID(), inbox.id, key, serialized, hash, now, now, now)
    .run();
  return find();
}

function idempotencyKey(context: Context<Bindings>): string {
  try {
    const key = resolveIdempotencyKey(context.req.header("Idempotency-Key"));
    context.header("Idempotency-Key", key);
    return key;
  } catch {
    throw new ApiError(400, "Invalid Idempotency-Key (1-128 ASCII letters, digits, or _.:-)");
  }
}

async function queueSend(context: Context<Bindings>, payload: StoredSendPayload) {
  const inbox = context.get("inbox");
  if (!inbox.active) throw new ApiError(409, "Inbox is disabled");
  const key = idempotencyKey(context);
  const serialized = JSON.stringify(payload);
  const hash = await sha256(serialized);
  const now = Date.now();
  const row = await findOrCreateOutbox(context, { key, serialized, hash, now, payload });
  if (row instanceof Response) return row;
  if (!row) throw new Error("Outbox record not found after insert");
  if (row.payload_hash !== hash)
    throw new ApiError(409, "Idempotency-Key already used for different content");
  if (row.status === "pending") await enqueue(context.env, "outbound", row.id);
  return context.json(publicOutbox(row), outboxHttpStatus(row.status));
}

function outboxHttpStatus(status: Outbox["status"]): 200 | 202 {
  return status === "pending" || status === "sending" ? 202 : 200;
}

function attachmentFilename(context: Context<Bindings>): string {
  try {
    const encoded = context.req.header("Agentpost-Filename") ?? "";
    if (encoded.length > 765) throw new Error("Invalid filename");
    const filename = decodeURIComponent(encoded);
    attachmentType(filename);
    return filename;
  } catch {
    throw new ApiError(400, "Agentpost-Filename must contain a valid percent-encoded filename");
  }
}

app.post("/v1/inboxes/:inbox/attachments", async (context) => {
  const inbox = context.get("inbox");
  if (!inbox.active) throw new ApiError(409, "Inbox is disabled");
  if (context.req.header("Content-Type") !== "application/octet-stream")
    throw new ApiError(415, "Content-Type must be application/octet-stream");
  const filename = attachmentFilename(context);
  const stream = context.req.raw.body;
  const bytes = stream ? await readBounded(stream, MAX_ATTACHMENT_BYTES) : new ArrayBuffer(0);
  const result = await uploadAttachment(context.env, inbox.id, filename, bytes, async () => {
    const limited = await enforceRateLimit(
      context.env.AGENTPOST_SEND_LIMITER,
      `attachment-upload:${inbox.id}`,
    );
    if (limited)
      throw new ApiError(
        limited.status === 429 ? 429 : 503,
        "Attachment upload admission unavailable; retry later",
      );
  });
  return context.json(result, result.reused ? 200 : 201);
});

app.post("/v1/inboxes/:inbox/send", async (context) => {
  const input = await readJson(context, sendInput);
  return queueSend(context, { from: context.get("inbox").address, ...input });
});

type ParsedMail = Awaited<ReturnType<typeof parseMime>>;
function replyReferences(parsed: ParsedMail): string | undefined {
  return `${parsed.references ?? ""} ${parsed.messageId ?? ""}`
    .match(/<[^<>\s\p{Cc}]{1,250}>/gu)
    ?.slice(-20)
    .join(" ");
}

function replyHeaders(parsed: ParsedMail): Record<string, string> {
  const refs = replyReferences(parsed);
  const messageId = parsed.messageId?.match(/^<[^<>\s\p{Cc}]{1,250}>$/u)?.[0];
  const headers: Record<string, string> = {};
  if (messageId) headers["In-Reply-To"] = messageId;
  if (refs) headers.References = refs;
  return headers;
}
function replyPayload(
  from: string,
  row: Message,
  parsed: ParsedMail,
  input: z.output<typeof replyInput>,
): StoredSendPayload {
  const target = replyAddress(parsed, row);
  const headers = replyHeaders(parsed);
  const subject = row.subject ?? "";
  return {
    from,
    to: [target],
    subject: (/^re:/i.test(subject) ? subject : `Re: ${subject}`)
      .replace(/\p{Cc}/gu, " ")
      .slice(0, 998),
    ...input,
    ...(Object.keys(headers).length ? { headers } : {}),
  };
}

function replyAddress(parsed: ParsedMail, row: Message): string {
  const target = parsed.replyTo?.[0]?.address ?? originalSender(parsed, row);
  if (!address.safeParse(target).success)
    throw new ApiError(409, "Message has no valid reply address");
  return target;
}

function originalSender(parsed: ParsedMail, row: Message): string {
  return parsed.from?.address ?? row.envelope_from;
}

app.post("/v1/inboxes/:inbox/messages/:message/reply", async (context) => {
  const row = await findMessage(context);
  if (row.status !== "ready") throw new ApiError(409, "Message is not parsed yet");
  const input = await readJson(context, replyInput);
  const object = await context.env.MAIL.get(row.raw_key);
  if (!object) throw new ApiError(503, "Original MIME unavailable");
  const parsed = await parseMime(await object.arrayBuffer());
  return queueSend(context, replyPayload(context.get("inbox").address, row, parsed, input));
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

function apiErrorResponse(error: ApiError, context: Context<Bindings>) {
  if (error.status === 429) context.header("Retry-After", "60");
  return context.json({ error: error.message, details: error.details }, error.status);
}

app.onError((error, context) => {
  if (error instanceof WebhookError) return context.json({ error: error.message }, error.status);
  if (error instanceof EventQueryError) return context.json({ error: error.message }, error.status);
  if (error instanceof AttachmentError) return context.json({ error: error.message }, error.status);
  if (error instanceof ApiError) return apiErrorResponse(error, context);
  if (error.message === "Message exceeds size limit")
    return context.json({ error: "Request body too large" }, 413);
  console.error(JSON.stringify({ event: "request_failed" }));
  return context.json(
    { error: "Internal error; retry send requests only with their original Idempotency-Key" },
    500,
  );
});

export default app;
