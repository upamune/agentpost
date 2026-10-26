import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, expect, test, vi } from "vitest";
import { readStoredObject } from "../src/mail-storage";
import { publishJobs } from "../src/queue-jobs";
import { maintain } from "../src/maintenance";
import { parseMessage } from "../src/inbound";
import { sha256 } from "../src/common";
import { cloudflareSend } from "../src/outbound";
import { prepareAttachments, uploadAttachment } from "../src/attachments";
import { recoverForwarding } from "../src/forwarding";
import type { Env, Job } from "../src/types";

const bindings: Env = env;
beforeEach(async () => {
  await reset();
  await applyD1Migrations(bindings.DB, env.TEST_MIGRATIONS);
});

async function inbox() {
  const id = crypto.randomUUID();
  await bindings.DB.prepare(
    "INSERT INTO inboxes(id,address,label,token_hash,created_at) VALUES (?,?, '',?,0)",
  )
    .bind(id, `${id}@example.com`, id)
    .run();
  return id;
}

test("queue publication chunks compact jobs at the 100-message platform boundary", async () => {
  const batches: MessageSendRequest<Job>[][] = [];
  const queue = {
    ...bindings.JOBS,
    async sendBatch(items: Iterable<MessageSendRequest<Job>>) {
      const batch = [...items];
      batches.push(batch);
      return bindings.JOBS.sendBatch(batch);
    },
  };
  const jobs: Job[] = Array.from({ length: 205 }, () => ({
    kind: "outbound",
    id: crypto.randomUUID(),
  }));
  await publishJobs(queue, []);
  await publishJobs(queue, jobs);
  expect(batches.map((batch) => batch.length)).toEqual([100, 100, 5]);
  expect(batches.flat().map((item) => item.body)).toEqual(jobs);
  for (const batch of batches)
    expect(new TextEncoder().encode(JSON.stringify(batch)).length).toBeLessThan(256 * 1024);
});

test("recovery reports publication failure while independently publishing other durable work", async () => {
  const box = await inbox();
  const message = await sha256("batch recovery");
  await bindings.DB.prepare(
    "INSERT INTO messages(id,inbox_id,raw_key,envelope_from,envelope_to,created_at) VALUES (?,?,?,'sender@example.net','recipient@example.com',0)",
  )
    .bind(message, box, `raw/${message}.eml`)
    .run();
  const send = crypto.randomUUID();
  await bindings.DB.prepare(
    "INSERT INTO outbox(id,inbox_id,idempotency_key,payload,payload_hash,available_at,created_at,updated_at) VALUES (?,?,?,'{}','hash',0,0,0)",
  )
    .bind(send, box, send)
    .run();
  const published: Job[] = [];
  const queue = {
    ...bindings.JOBS,
    async sendBatch(items: Iterable<MessageSendRequest<Job>>) {
      const batch = [...items];
      if (batch[0]?.body.kind === "inbound") throw new Error("Queue unavailable");
      published.push(...batch.map((item) => item.body));
      return bindings.JOBS.sendBatch(batch);
    },
  };
  await expect(maintain({ ...bindings, JOBS: queue })).rejects.toThrow("Scheduled recovery failed");
  expect(published).toEqual([{ kind: "outbound", id: send }]);
  expect(
    await bindings.DB.prepare("SELECT status FROM messages WHERE id=?")
      .bind(message)
      .first("status"),
  ).toBe("pending");
  expect(
    await bindings.DB.prepare("SELECT status FROM outbox WHERE id=?").bind(send).first("status"),
  ).toBe("pending");
});

test("stored-object reads reject oversize metadata before reading and cancel the R2 body", async () => {
  await bindings.MAIL.put("oversize", "123456");
  const object = (await bindings.MAIL.get("oversize"))!;
  const cancel = vi.spyOn(object.body, "cancel");
  await expect(readStoredObject(object, 5)).rejects.toThrow("Stored object exceeds size limit");
  expect(cancel).toHaveBeenCalledOnce();
  expect(await bindings.MAIL.head("oversize")).not.toBeNull();
});

test("R2 attachment puts validate and retain the SHA-256 checksum", async () => {
  const box = await inbox();
  const attachment = await uploadAttachment(
    bindings,
    box,
    "report.txt",
    Uint8Array.from(new TextEncoder().encode("Report")).buffer,
  );
  const object = (await bindings.MAIL.head(`outbound-attachments/${box}/${attachment.id}`))!;
  expect(object.checksums.toJSON().sha256).toBe(attachment.sha256);
});

test("rejecting stored attachment metadata cancels its unread R2 body", async () => {
  const box = await inbox();
  const bytes = Uint8Array.from(new TextEncoder().encode("Report"));
  const attachment = await uploadAttachment(bindings, box, "report.txt", bytes.buffer);
  const key = `outbound-attachments/${box}/${attachment.id}`;
  await bindings.MAIL.put(key, bytes, { customMetadata: { manifest: "invalid" } });
  const object = (await bindings.MAIL.get(key))!;
  const cancel = vi.spyOn(object.body, "cancel");
  const storage = { ...bindings.MAIL, get: vi.fn(async () => object) };
  await expect(
    prepareAttachments({ ...bindings, MAIL: storage }, box, {
      from: "sender@example.com",
      to: ["receiver@example.net"],
      subject: "Fixture",
      text: "Fixture",
      attachments: [attachment.id],
    }),
  ).rejects.toThrow("Stored attachment metadata is invalid");
  expect(cancel).toHaveBeenCalledOnce();
});

test("stored-object reads also enforce the stream limit when size metadata understates it", async () => {
  await bindings.MAIL.put("understated", "123456");
  const object = (await bindings.MAIL.get("understated"))!;
  const understated = new Proxy(object, {
    get(target, key) {
      return key === "size" ? 0 : Reflect.get(target, key);
    },
  });
  await expect(readStoredObject(understated, 5)).rejects.toThrow(
    "Stored object exceeds size limit",
  );
  expect(object.body.locked).toBe(false);
  expect(object.bodyUsed).toBe(true);
});

test("provider responses are bounded and rejected response bodies are released without resending", async () => {
  const payload = {
    from: "sender@example.com",
    to: ["receiver@example.net"],
    subject: "Fixture",
    text: "Fixture",
  };
  const rejected = new Response("Unused provider error", { status: 429 });
  const cancel = vi.spyOn(rejected.body!, "cancel");
  expect((await cloudflareSend(bindings, payload, async () => rejected)).status).toBe("retry");
  expect(cancel).toHaveBeenCalledOnce();
  const oversized = Response.json({ success: true, result: "x".repeat(65 * 1024) });
  const request = vi.fn(async () => oversized);
  expect((await cloudflareSend(bindings, payload, request)).status).toBe("unknown");
  expect(request).toHaveBeenCalledOnce();
});

test("oversize retained MIME never becomes parsed or ready and remains recoverable", async () => {
  const box = await inbox();
  const id = await sha256("oversize original");
  const key = `raw/${box}/${id}.eml`;
  await bindings.MAIL.put(key, new Uint8Array(10 * 1024 * 1024 + 1));
  await bindings.DB.prepare(
    "INSERT INTO messages(id,inbox_id,raw_key,envelope_from,envelope_to,created_at) VALUES (?,?,?,'sender@example.net','recipient@example.com',0)",
  )
    .bind(id, box, key)
    .run();
  await expect(parseMessage(bindings, id)).rejects.toThrow("Stored object exceeds size limit");
  expect(await bindings.MAIL.head(key)).not.toBeNull();
  expect(await bindings.MAIL.head(`parsed/${id}.json`)).toBeNull();
  expect(
    await bindings.DB.prepare("SELECT status FROM messages WHERE id=?").bind(id).first("status"),
  ).toBe("pending");
  expect(await bindings.DB.prepare("SELECT count(*) FROM events").first("count(*)")).toBe(0);
});

test("recovery and webhook publication queries use indexes instead of scanning delivery history", async () => {
  const queries = [
    [
      "SELECT id FROM outbox WHERE status = 'pending' AND available_at <= 1 ORDER BY available_at, created_at, id LIMIT 100",
      "outbox_pending",
    ],
    [
      "SELECT id, inbox_id FROM outbox WHERE status = 'sending' AND updated_at < 1 ORDER BY updated_at, id LIMIT 100",
      "outbox_recovery_sending",
    ],
    [
      "SELECT id FROM webhook_deliveries WHERE message_id = 'fixture' AND status = 'pending'",
      "webhook_delivery_message",
    ],
    [
      "SELECT id, available_at AS due_at FROM webhook_deliveries WHERE status = 'pending' AND available_at <= 1 UNION ALL SELECT id, updated_at AS due_at FROM webhook_deliveries WHERE status = 'sending' AND updated_at < 1 ORDER BY due_at, id LIMIT 100",
      "webhook_recovery_sending",
    ],
  ];
  for (const [sql, index] of queries) {
    const result = await bindings.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).all<{ detail: string }>();
    const plan = result.results.map((row) => row.detail).join("\n");
    expect(plan).toContain(index);
    expect(plan).not.toMatch(/USE TEMP B-TREE|SCAN (outbox|webhook_deliveries)\b/);
  }
});

test("forwarding recovery bounds each state update and never resets uncertain work to pending", async () => {
  const box = await inbox();
  const inserts: D1PreparedStatement[] = [];
  for (let index = 0; index < 202; index++) {
    const id = await sha256(`forwarding backlog ${index}`);
    inserts.push(
      bindings.DB.prepare(
        "INSERT INTO messages(id,inbox_id,raw_key,envelope_from,envelope_to,created_at) VALUES (?,?,?,'sender@example.net','recipient@example.com',0)",
      ).bind(id, box, `raw/${id}.eml`),
    );
    inserts.push(
      bindings.DB.prepare(
        "INSERT INTO forwarding_deliveries(message_id,inbox_id,status,created_at,updated_at) VALUES (?,?,?,0,0)",
      ).bind(id, box, index % 2 ? "sending" : "pending"),
    );
  }
  await bindings.DB.batch(inserts);
  await recoverForwarding(bindings);
  const counts = async () =>
    (
      await bindings.DB.prepare(
        "SELECT status,count(*) AS n FROM forwarding_deliveries GROUP BY status ORDER BY status",
      ).all<{ status: string; n: number }>()
    ).results;
  expect(await counts()).toEqual([
    { status: "blocked", n: 100 },
    { status: "pending", n: 1 },
    { status: "sending", n: 1 },
    { status: "unknown", n: 100 },
  ]);
  await recoverForwarding(bindings);
  expect(await counts()).toEqual([
    { status: "blocked", n: 101 },
    { status: "unknown", n: 101 },
  ]);
});
