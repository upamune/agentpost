import PostalMime from "postal-mime";
import { stringifyBoundedJson } from "./bounded-json";
import { MAX_MAIL_BYTES, readBounded, sha256 } from "./common";
import type { Env, Inbox, Message } from "./types";

export function parseMime(raw: ArrayBuffer) {
  return PostalMime.parse(raw, {
    maxNestingDepth: 32,
    maxHeadersSize: 128 * 1024,
    maxPartCount: 1000,
    maxRfc822NestingDepth: 4,
    maxForwardedAddresses: 100,
  });
}

export async function enqueue(env: Env, kind: "inbound" | "outbound", id: string): Promise<void> {
  try {
    await env.JOBS.send({ kind, id });
  } catch {
    // D1/R2 remain the durable source. The scheduled repair republishes pending work.
    console.error(JSON.stringify({ event: "queue_publish_failed", kind, id }));
  }
}

export async function receive(message: ForwardableEmailMessage, env: Env): Promise<void> {
  const inbox = await env.DB.prepare("SELECT * FROM inboxes WHERE address = ? AND active = 1")
    .bind(message.to.toLowerCase())
    .first<Inbox>();
  if (!inbox) {
    message.setReject("Unknown or disabled recipient");
    return;
  }
  if (message.rawSize > MAX_MAIL_BYTES) {
    message.setReject("Message exceeds 10 MiB limit");
    return;
  }
  const raw = await readBounded(message.raw, MAX_MAIL_BYTES);
  const hash = await sha256(raw);
  const id = await sha256(`${inbox.id}:${hash}`);
  const key = `raw/${inbox.id}/${id}.eml`;
  // Persist the original MIME before any parsing or queue operation.
  const existing = await env.MAIL.head(key);
  if (!existing) {
    await env.MAIL.put(key, raw, {
      httpMetadata: { contentType: "message/rfc822" },
      customMetadata: {
        id,
        inbox_id: inbox.id,
        envelope_from: message.from,
        envelope_to: message.to,
        created_at: String(Date.now()),
      },
    });
  }
  await indexRaw(env, key, await rawMetadata(env, key, existing));
  await enqueue(env, "inbound", id);
}

async function rawMetadata(env: Env, key: string, existing: R2Object | null) {
  return existing?.customMetadata ?? (await env.MAIL.head(key))?.customMetadata;
}

class RawIndexError extends Error {
  constructor(public code: "invalid_metadata" | "missing_inbox") {
    super(code);
  }
}

function rawIdentityMatches(key: string, meta: Record<string, string>): boolean {
  return (
    /^[a-f0-9]{64}$/.test(meta.id ?? "") &&
    /^[a-f0-9-]{36}$/.test(meta.inbox_id ?? "") &&
    key === `raw/${meta.inbox_id}/${meta.id}.eml`
  );
}
function validRawEnvelope(meta: Record<string, string>): boolean {
  return (
    Boolean(meta.envelope_to) &&
    /^\d+$/.test(meta.created_at ?? "") &&
    Number.isSafeInteger(Number(meta.created_at))
  );
}

async function indexRaw(
  env: Env,
  key: string,
  meta: Record<string, string> | undefined,
): Promise<void> {
  if (!meta || !rawIdentityMatches(key, meta) || !validRawEnvelope(meta)) {
    throw new RawIndexError("invalid_metadata");
  }
  const inbox = await env.DB.prepare("SELECT id FROM inboxes WHERE id = ?")
    .bind(meta.inbox_id)
    .first();
  if (!inbox) throw new RawIndexError("missing_inbox");
  await env.DB.prepare(
    "INSERT OR IGNORE INTO messages (id, inbox_id, raw_key, envelope_from, envelope_to, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(
      meta.id,
      meta.inbox_id,
      key,
      meta.envelope_from ?? "",
      meta.envelope_to,
      Number(meta.created_at),
    )
    .run();
}

export async function parseMessage(env: Env, id: string): Promise<void> {
  const message = await env.DB.prepare("SELECT * FROM messages WHERE id = ?")
    .bind(id)
    .first<Message>();
  if (!message || message.status === "ready") return;
  const object = await env.MAIL.get(message.raw_key);
  if (!object) throw new Error("Original MIME is missing");
  const parsed = await parseMime(await object.arrayBuffer());
  const document = {
    from: parsed.from,
    to: parsed.to,
    cc: parsed.cc,
    reply_to: parsed.replyTo,
    ...parsedContent(parsed),
    message_id: parsed.messageId,
    references: parsed.references,
    date: parsed.date,
    attachments: parsed.attachments.map((attachment, index) => ({
      index,
      filename: attachment.filename,
      mime_type: attachment.mimeType,
      size:
        typeof attachment.content === "string"
          ? attachment.content.length
          : attachment.content.byteLength,
    })),
  };
  await env.MAIL.put(`parsed/${id}.json`, stringifyBoundedJson(document, 16 * 1024 * 1024), {
    httpMetadata: { contentType: "application/json" },
  });
  await env.DB.prepare(
    "UPDATE messages SET status = 'ready', subject = ?, error = NULL WHERE id = ?",
  )
    .bind(document.subject, id)
    .run();
}

function parsedContent(parsed: Awaited<ReturnType<typeof parseMime>>) {
  return { subject: parsed.subject ?? "", text: parsed.text ?? "", html: parsed.html ?? "" };
}

async function rawRecoveryPage(env: Env) {
  const state = await env.DB.prepare(
    "SELECT value FROM maintenance WHERE key = 'raw_cursor'",
  ).first<{ value: string }>();
  return env.MAIL.list({
    prefix: "raw/",
    limit: 100,
    cursor: state?.value || undefined,
    include: ["customMetadata"],
  });
}

export async function repairRawIndex(env: Env): Promise<void> {
  const page = await rawRecoveryPage(env);
  let failures = 0;
  for (const object of page.objects) {
    try {
      await indexRaw(env, object.key, object.customMetadata);
      await env.DB.prepare("DELETE FROM raw_recovery_failures WHERE raw_key = ?")
        .bind(object.key)
        .run();
    } catch (error) {
      // One poisoned object must not pin the cursor and starve every later page.
      // Recording attention must succeed before the cursor can move past it.
      const code = error instanceof RawIndexError ? error.code : "index_write_failed";
      await env.DB.prepare(
        "INSERT INTO raw_recovery_failures (raw_key, error_code, updated_at) VALUES (?, ?, ?) ON CONFLICT(raw_key) DO UPDATE SET error_code = excluded.error_code, updated_at = excluded.updated_at",
      )
        .bind(object.key, code, Date.now())
        .run();
      failures++;
    }
  }
  await env.DB.prepare(
    "INSERT INTO maintenance (key, value) VALUES ('raw_cursor', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  )
    .bind(page.truncated ? page.cursor : "")
    .run();
  if (failures) {
    console.error(JSON.stringify({ event: "raw_index_attention_required", count: failures }));
    throw new Error("Raw index recovery has unresolved objects");
  }
}
