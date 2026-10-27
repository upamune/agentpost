import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import PostalMime from "postal-mime";
import app from "../src/api";
import {
  MAX_ATTACHMENT_BYTES,
  validateAttachment,
  decodeAttachment,
  encodeAttachment,
  validateMailSize,
} from "../src/attachment-policy";
import { cloudflareSend, processOutbound } from "../src/outbound";
import { attachmentMime } from "../src/outbound-mime";
import { parseMessage, receive } from "../src/inbound";
import { sha256 } from "../src/common";
import type { Env, SendPayload } from "../src/types";
const bindings: Env = env;
const admin = "test-admin-token-with-at-least-32-characters";
type Box = { id: string; token: string; address: string };
type Uploaded = { id: string; sha256: string; size: number; scan_status: string; reused: boolean };
const bytes = new TextEncoder().encode("name,value\nanswer,42\n");
beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
afterEach(() => vi.restoreAllMocks());
async function inbox(): Promise<Box> {
  return (
    await app.request(
      "https://mail.test/v1/inboxes",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${admin}`, "Content-Type": "application/json" },
        body: "{}",
      },
      bindings,
    )
  ).json();
}
async function upload(box: Box, content = bytes, name = "report.csv") {
  return app.request(
    `https://mail.test/v1/inboxes/${box.id}/attachments`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${box.token}`,
        "Content-Type": "application/octet-stream",
        "Agentpost-Filename": encodeURIComponent(name),
      },
      body: content,
    },
    bindings,
  );
}
async function send(box: Box, ids?: string[], key = "send-attachment", endpoint = "send") {
  const body =
    endpoint === "send"
      ? { to: ["recipient@example.net"], subject: "Report", text: "Attached." }
      : { text: "Attached." };
  return app.request(
    `https://mail.test/v1/inboxes/${box.id}/${endpoint}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${box.token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: JSON.stringify({ ...body, ...(ids ? { attachments: ids } : {}) }),
    },
    bindings,
  );
}

test("immutable inbox-scoped uploads round-trip through the actual provider request", async () => {
  const box = await inbox();
  const first = await upload(box);
  expect(first.status).toBe(201);
  const file = await first.json<Uploaded>();
  expect(file).toMatchObject({ size: bytes.length, scan_status: "not_scanned", reused: false });
  const again = await upload(box);
  expect(again.status).toBe(200);
  expect(await again.json()).toMatchObject({ id: file.id, reused: true });
  const queued = await send(box, [file.id]);
  expect(queued.status).toBe(202);
  const row = await queued.json<{ id: string; payload: { attachments: string[] } }>();
  expect(row.payload.attachments).toEqual([file.id]);
  const request = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(Response.json({ success: true, result: { id: "provider-1" } }));
  await processOutbound(
    bindings,
    row.id,
    box.id,
    () => {},
    async () => true,
  );
  const payload = JSON.parse(String(request.mock.calls[0]?.[1]?.body));
  expect(request.mock.calls[0]?.[0]).toMatch(/\/email\/sending\/send_raw$/);
  expect(payload.from).toBe(box.address);
  expect(payload.recipients).toEqual(["recipient@example.net"]);
  const parsed = await PostalMime.parse(payload.mime_message);
  expect(parsed.attachments[0]).toMatchObject({ filename: "report.csv", mimeType: "text/csv" });
  expect(new Uint8Array(parsed.attachments[0]!.content as ArrayBuffer)).toEqual(bytes);
  await processOutbound(
    bindings,
    row.id,
    box.id,
    () => {},
    async () => true,
  );
  expect(request).toHaveBeenCalledTimes(1);
  expect((await send(box, [file.id])).status).toBe(200);
  expect(
    (await send(box, [(await (await upload(box, bytes, "other.csv")).json<Uploaded>()).id])).status,
  ).toBe(409);
});

test.each([
  ["report.csv", "text/csv", "name,value\nanswer,42\n"],
  ["report.txt", "text/plain", "first\nsecond\r\nthird\rfinal"],
  ["report.log", "text/plain", "log\n"],
  ["report.md", "text/markdown", "# Report\n日本語\n"],
  ["report.json", "application/json", '{"answer":42}\n'],
  ["report.jsonl", "application/x-ndjson", '{"answer":42}\n'],
  ["report.ndjson", "application/x-ndjson", '{"answer":42}\n'],
  ["report.pdf", "application/pdf", "%PDF-1.4\n%%EOF\n"],
])("provider MIME preserves file bytes for %s", async (filename, detectedType, text) => {
  const box = await inbox();
  const original = new TextEncoder().encode(text);
  const uploaded = await upload(box, original, filename);
  expect(uploaded.status).toBe(201);
  const file = await uploaded.json<Uploaded & { type: string }>();
  expect(file.type).toBe(detectedType);
  const row = await (await send(box, [file.id])).json<{ id: string }>();
  const request = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(Response.json({ success: true, result: { id: "provider-file-integrity" } }));
  await processOutbound(
    bindings,
    row.id,
    box.id,
    () => {},
    async () => true,
  );
  const payload = JSON.parse(String(request.mock.calls[0]?.[1]?.body));
  const parsed = await PostalMime.parse(payload.mime_message);
  const attachment = parsed.attachments[0];
  // Cloudflare's structured builder changed even octet-stream LF files to 7bit/CRLF.
  expect(payload.mime_message).toContain("Content-Transfer-Encoding: base64");
  expect(attachment?.mimeType).toBe(detectedType);
  expect(attachment?.filename).toBe(filename);
  expect(new Uint8Array(attachment!.content as ArrayBuffer)).toEqual(original);
  expect((await (await upload(box, original, filename)).json<Uploaded>()).id).toBe(file.id);
});

test("raw MIME preserves Unicode, alternative bodies, filenames, recipients and reply threading", async () => {
  const text = "First line\n日本語\r\nFinal line\r";
  const payload: SendPayload = {
    from: "sender@example.com",
    to: Array.from({ length: 50 }, (_, index) => `recipient-${index}@example.net`),
    subject: "日本語🙂".repeat(199),
    text,
    html: "<p>日本語🙂</p>",
    headers: {
      "In-Reply-To": "<parent@example.net>",
      References: "<first@example.net> <parent@example.net>",
    },
    attachments: [
      {
        filename: '日本語"; name="report.csv',
        type: "text/csv",
        content: encodeAttachment(bytes),
        disposition: "attachment",
      },
      {
        filename: "dot.png",
        type: "image/png",
        content: encodeAttachment(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 255])),
        disposition: "attachment",
      },
    ],
  };
  const raw = attachmentMime(payload);
  const parsed = await PostalMime.parse(raw);
  expect(parsed.subject).toBe(payload.subject);
  expect(parsed.to?.map((mailbox) => ("address" in mailbox ? mailbox.address : ""))).toEqual(
    payload.to,
  );
  expect(parsed.html).toBe(payload.html);
  expect(parsed.text?.replace(/\r\n?/g, "\n")).toBe(text.replace(/\r\n?/g, "\n"));
  expect(parsed.inReplyTo).toBe(payload.headers!["In-Reply-To"]);
  expect(parsed.references).toBe(payload.headers!.References);
  expect(parsed.attachments.map((file) => file.filename)).toEqual(
    payload.attachments!.map((file) => file.filename),
  );
  expect(new Uint8Array(parsed.attachments[0]!.content as ArrayBuffer)).toEqual(bytes);
  expect(new Uint8Array(parsed.attachments[1]!.content as ArrayBuffer)).toEqual(
    decodeAttachment(payload.attachments![1]!.content),
  );
  expect(raw.split("\r\n").every((line) => line.length <= 998)).toBe(true);
  expect(raw.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
  expect(raw.match(/Content-Transfer-Encoding: base64/g)).toHaveLength(4);
});

test("MIME construction errors and encoded size overflow never contact the provider", async () => {
  const payload: SendPayload = {
    from: "sender@example.com",
    to: ["recipient@example.net"],
    subject: "Report",
    text: "Attached.",
    attachments: [
      {
        filename: "report.csv",
        type: "text/csv",
        content: encodeAttachment(bytes),
        disposition: "attachment",
      },
    ],
  };
  const request = vi.fn();
  for (const invalid of [
    { ...payload, subject: "Report\r\nBcc: stolen@example.org" },
    { ...payload, headers: { Bcc: "stolen@example.org" } },
    { ...payload, headers: { References: "<parent@example.net>\r\nBcc: stolen@example.org" } },
    { ...payload, attachments: [{ ...payload.attachments![0]!, filename: "bad\r\nname.csv" }] },
    {
      ...payload,
      attachments: [{ ...payload.attachments![0]!, type: "text/csv\r\nBcc: stolen@example.org" }],
    },
    {
      ...payload,
      attachments: [{ ...payload.attachments![0]!, content: "A".repeat(5 * 1024 * 1024) }],
    },
  ]) {
    expect(await cloudflareSend(bindings, invalid, request)).toMatchObject({ status: "failed" });
  }
  expect(request).not.toHaveBeenCalled();
});

test("foreign, missing, duplicate IDs and disabled inbox uploads cannot be queued", async () => {
  const owner = await inbox();
  const other = await inbox();
  const file = await (await upload(owner)).json<Uploaded>();
  expect((await send(other, [file.id])).status).toBe(404);
  expect((await send(owner, ["a".repeat(64)])).status).toBe(404);
  expect((await send(owner, [file.id, file.id])).status).toBe(400);
  const denied = await app.request(
    `https://mail.test/v1/inboxes/${owner.id}/attachments`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${other.token}`,
        "Content-Type": "application/octet-stream",
        "Agentpost-Filename": "report.csv",
      },
      body: bytes,
    },
    bindings,
  );
  expect(denied.status).toBe(404);
  await bindings.DB.prepare("UPDATE inboxes SET active = 0 WHERE id = ?").bind(owner.id).run();
  expect((await upload(owner)).status).toBe(401);
  expect((await upload({ ...owner, token: admin })).status).toBe(409);
});

test("legacy no-attachment idempotency hash is preserved with explicit empty attachments", async () => {
  const box = await inbox();
  const first = await send(box);
  const row = await first.json<{ id: string }>();
  const expected = {
    from: box.address,
    to: ["recipient@example.net"],
    subject: "Report",
    text: "Attached.",
  };
  const stored = await bindings.DB.prepare("SELECT payload, payload_hash FROM outbox WHERE id = ?")
    .bind(row.id)
    .first<{ payload: string; payload_hash: string }>();
  expect(stored?.payload).toBe(JSON.stringify(expected));
  expect(stored?.payload_hash).toBe(await sha256(JSON.stringify(expected)));
  expect((await send(box, [])).status).toBe(202);
});

test("an existing outbox retry does not depend on attachment storage", async () => {
  const box = await inbox();
  const file = await (await upload(box)).json<Uploaded>();
  const row = await (await send(box, [file.id])).json<{ id: string }>();
  await bindings.MAIL.delete(`outbound-attachments/${box.id}/${file.id}`);
  expect((await send(box, [file.id])).status).toBe(202);
  const sender = vi.fn();
  await processOutbound(
    bindings,
    row.id,
    box.id,
    () => {},
    async () => true,
    sender,
  );
  expect(sender).not.toHaveBeenCalled();
  expect(
    await bindings.DB.prepare("SELECT status FROM outbox WHERE id = ?").bind(row.id).first(),
  ).toEqual({ status: "failed" });
});

test("corrupt stored bytes are rejected before dispatch or fencing", async () => {
  const box = await inbox();
  const file = await (await upload(box)).json<Uploaded>();
  const row = await (await send(box, [file.id])).json<{ id: string }>();
  const key = `outbound-attachments/${box.id}/${file.id}`;
  const object = await bindings.MAIL.head(key);
  await bindings.MAIL.put(key, new Uint8Array(bytes.length).fill(65), {
    customMetadata: object?.customMetadata,
  });
  const sender = vi.fn();
  const fence = vi.fn();
  await processOutbound(bindings, row.id, box.id, fence, async () => true, sender);
  expect(sender).not.toHaveBeenCalled();
  expect(fence).not.toHaveBeenCalled();
  expect(
    await bindings.DB.prepare("SELECT status FROM outbox WHERE id = ?").bind(row.id).first(),
  ).toEqual({ status: "failed" });
});

test("storage failures before dispatch are safely retryable, but fence failures are never caught as retries", async () => {
  const box = await inbox();
  const file = await (await upload(box)).json<Uploaded>();
  const row = await (await send(box, [file.id])).json<{ id: string }>();
  const sender = vi.fn();
  const unavailable = {
    ...bindings,
    MAIL: new Proxy(bindings.MAIL, {
      get(target, property) {
        if (property === "get")
          return async () => {
            throw new Error("R2 unavailable");
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  };
  await processOutbound(
    unavailable,
    row.id,
    box.id,
    () => {},
    async () => true,
    sender,
  );
  expect(sender).not.toHaveBeenCalled();
  expect(
    await bindings.DB.prepare("SELECT status FROM outbox WHERE id = ?").bind(row.id).first(),
  ).toEqual({ status: "pending" });
  await bindings.DB.prepare("UPDATE outbox SET available_at = 0 WHERE id = ?").bind(row.id).run();
  await expect(
    processOutbound(
      bindings,
      row.id,
      box.id,
      () => {
        throw new Error("ownership lost");
      },
      async () => true,
      sender,
    ),
  ).rejects.toThrow("ownership lost");
  expect(sender).not.toHaveBeenCalled();
  expect(
    await bindings.DB.prepare("SELECT status FROM outbox WHERE id = ?").bind(row.id).first(),
  ).toEqual({ status: "sending" });
});

test("reply attachments preserve threading and the original Reply-To", async () => {
  const box = await inbox();
  const file = await (await upload(box)).json<Uploaded>();
  const raw = new TextEncoder().encode(
    `From: sender@example.net\r\nReply-To: reply@example.net\r\nTo: ${box.address}\r\nSubject: Original\r\nMessage-ID: <original@example.net>\r\n\r\nPlease send a report.\r\n`,
  );
  await receive(
    {
      from: "sender@example.net",
      to: box.address,
      rawSize: raw.length,
      raw: new Response(raw).body!,
      headers: new Headers(),
      setReject(reason: string) {
        throw new Error(reason);
      },
      forward() {
        throw new Error("unexpected");
      },
      reply() {
        throw new Error("unexpected");
      },
    },
    bindings,
  );
  const message = await bindings.DB.prepare("SELECT id FROM messages WHERE inbox_id = ?")
    .bind(box.id)
    .first<{ id: string }>();
  await parseMessage(bindings, message!.id);
  const response = await send(box, [file.id], "reply-attachment", `messages/${message!.id}/reply`);
  expect(response.status).toBe(202);
  expect((await response.json<{ payload: unknown }>()).payload).toMatchObject({
    to: ["reply@example.net"],
    subject: "Re: Original",
    attachments: [file.id],
    headers: { "In-Reply-To": "<original@example.net>" },
  });
});

test("binary and aggregate limits apply before queueing", async () => {
  const box = await inbox();
  expect(
    (await upload(box, new Uint8Array(MAX_ATTACHMENT_BYTES + 1).fill(65), "large.txt")).status,
  ).toBe(413);
  const large = await (
    await upload(box, new Uint8Array(MAX_ATTACHMENT_BYTES).fill(65), "large.txt")
  ).json<Uploaded>();
  expect((await send(box, [large.id])).status).toBe(413);
  expect(() => validateMailSize("a".repeat(1_800_000), undefined, [])).toThrow();
  expect(() => decodeAttachment("YQ==\n")).toThrow();
});

for (const filename of [
  "virus.exe",
  "archive.zip",
  "active.svg",
  "page.html",
  "../report.csv",
  "bad\r\n.csv",
  "\u202Etxt.csv",
  " bad.csv",
  "bad\uD800.csv",
]) {
  test(`reject dangerous filename ${JSON.stringify(filename)}`, () =>
    expect(() => validateAttachment(bytes, filename)).toThrow());
}
for (const [filename, data] of [
  ["fake.pdf", bytes],
  ["fake.png", bytes],
  ["script.txt", new TextEncoder().encode("#!/bin/sh\necho hi")],
  ["zip.txt", new Uint8Array([80, 75, 3, 4])],
  ["nul.txt", new Uint8Array([65, 0, 66])],
] as const) {
  test(`reject disguised content ${filename}`, () =>
    expect(() => validateAttachment(data, filename)).toThrow());
}

test("identical upload retries bypass new-upload slots but new bytes remain rate limited", async () => {
  const box = await inbox();
  const original = await (await upload(box)).json<Uploaded>();
  const exhausted = {
    ...bindings,
    AGENTPOST_SEND_LIMITER: { limit: async () => ({ success: false }) },
  };
  const request = (content: Uint8Array) =>
    app.request(
      `https://mail.test/v1/inboxes/${box.id}/attachments`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${box.token}`,
          "Content-Type": "application/octet-stream",
          "Agentpost-Filename": "report.csv",
        },
        body: content,
      },
      exhausted,
    );
  const reused = await request(bytes);
  expect(reused.status).toBe(200);
  expect(await reused.json()).toMatchObject({ id: original.id, reused: true });
  const newFile = await request(new TextEncoder().encode("changed,content\n"));
  expect(newFile.status).toBe(429);
  expect(newFile.headers.get("Retry-After")).toBe("60");
});
