import PostalMime from "postal-mime";
import { MAX_MAIL_BYTES, readBounded, sha256 } from "./common";
import type { Env, Inbox, Message } from "./types";

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
  await indexRaw(env, key, existing?.customMetadata ?? (await env.MAIL.head(key))?.customMetadata);
  await enqueue(env, "inbound", id);
}

async function indexRaw(
  env: Env,
  key: string,
  meta: Record<string, string> | undefined,
): Promise<void> {
  if (!meta?.id || !meta.inbox_id || !meta.envelope_to || !meta.created_at) {
    throw new Error("Raw message is missing recovery metadata");
  }
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
  const parsed = await PostalMime.parse(await object.arrayBuffer());
  const document = {
    from: parsed.from,
    to: parsed.to,
    cc: parsed.cc,
    reply_to: parsed.replyTo,
    subject: parsed.subject ?? "",
    text: parsed.text ?? "",
    html: parsed.html ?? "",
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
  await env.MAIL.put(`parsed/${id}.json`, JSON.stringify(document), {
    httpMetadata: { contentType: "application/json" },
  });
  await env.DB.prepare(
    "UPDATE messages SET status = 'ready', subject = ?, error = NULL WHERE id = ?",
  )
    .bind(document.subject, id)
    .run();
}

export async function repairRawIndex(env: Env): Promise<void> {
  const state = await env.DB.prepare(
    "SELECT value FROM maintenance WHERE key = 'raw_cursor'",
  ).first<{ value: string }>();
  const page = await env.MAIL.list({
    prefix: "raw/",
    limit: 100,
    cursor: state?.value || undefined,
    include: ["customMetadata"],
  });
  for (const object of page.objects) {
    await indexRaw(env, object.key, object.customMetadata);
  }
  await env.DB.prepare(
    "INSERT INTO maintenance (key, value) VALUES ('raw_cursor', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  )
    .bind(page.truncated ? page.cursor : "")
    .run();
}
