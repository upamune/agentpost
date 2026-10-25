import {
  applyD1Migrations,
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
  reset,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import app from "../src/api";
import worker from "../src/index";
import { sha256 } from "../src/common";
import type { Env, Job } from "../src/types";

const bindings: Env = env;
const raw = "From: sender@example.net\r\nSubject: Queue fixture\r\n\r\nRetain this original.\r\n";

beforeEach(async () => {
  await reset();
  await applyD1Migrations(bindings.DB, env.TEST_MIGRATIONS);
});
afterEach(() => vi.restoreAllMocks());

async function seedMessage(label: string, status: "pending" | "ready", retained: boolean) {
  const response = await app.request(
    "https://mail.test/v1/inboxes",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer test-admin-token-with-at-least-32-characters",
        "Content-Type": "application/json",
      },
      body: "{}",
    },
    bindings,
  );
  expect(response.status).toBe(201);
  const inbox = await response.json<{ id: string; address: string }>();
  const id = await sha256(label);
  const key = `raw/${inbox.id}/${id}.eml`;
  if (retained) await bindings.MAIL.put(key, raw);
  if (status === "ready") await bindings.MAIL.put(`parsed/${id}.json`, "{}");
  await bindings.DB.prepare(
    "INSERT INTO messages (id, inbox_id, raw_key, envelope_from, envelope_to, created_at, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(id, inbox.id, key, "sender@example.net", inbox.address, Date.now(), status)
    .run();
  return { id, key };
}

function delivery(queueId: string, id: string, attempts: number) {
  return {
    id: queueId,
    body: { kind: "inbound", id } satisfies Job,
    timestamp: new Date(),
    attempts,
  };
}

async function messageStatus(id: string) {
  return bindings.DB.prepare("SELECT status, error FROM messages WHERE id = ?")
    .bind(id)
    .first<{ status: string; error: string | null }>();
}

test("a failed queue item retries while later items commit parsed mail and acknowledge", async () => {
  const broken = await seedMessage("missing original", "pending", false);
  const valid = await seedMessage("retained original", "pending", true);
  const batch = createMessageBatch("fixture", [
    delivery("bad-job", broken.id, 4),
    delivery("good-job", valid.id, 1),
  ]);
  // The local queue-result helper omits delaySeconds; observe the public retry call too.
  const retry = vi.spyOn(batch.messages[0]!, "retry");
  await worker.queue(batch, bindings);
  const result = await getQueueResult(batch, createExecutionContext());
  expect(result.explicitAcks).toEqual(["good-job"]);
  expect(result.retryMessages).toEqual([{ msgId: "bad-job" }]);
  expect(retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: 240 });
  expect((await messageStatus(broken.id))?.status).toBe("pending");
  expect((await messageStatus(valid.id))?.status).toBe("ready");
  expect(await bindings.MAIL.head(`parsed/${valid.id}.json`)).not.toBeNull();
  expect(await bindings.MAIL.head(valid.key)).not.toBeNull();
});

test("exhausted parsing records attention and caps backoff without demoting ready mail", async () => {
  const pending = await seedMessage("exhausted pending", "pending", false);
  const ready = await seedMessage("already ready", "ready", true);
  const batch = createMessageBatch("fixture", [
    delivery("exhausted-job", pending.id, 5),
    delivery("ready-job", ready.id, 6),
  ]);
  const retry = vi.spyOn(batch.messages[0]!, "retry");
  await worker.queue(batch, bindings);
  const result = await getQueueResult(batch, createExecutionContext());
  expect(result.explicitAcks).toEqual(["ready-job"]);
  expect(result.retryMessages).toEqual([{ msgId: "exhausted-job" }]);
  expect(retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: 300 });
  expect(await messageStatus(pending.id)).toEqual({
    status: "failed",
    error: "Parsing failed; original MIME retained",
  });
  expect((await messageStatus(ready.id))?.status).toBe("ready");
});

test("duplicate queue deliveries acknowledge independently and publish one received event", async () => {
  const message = await seedMessage("duplicate delivery", "pending", true);
  const batch = createMessageBatch("fixture", [
    delivery("first-job", message.id, 1),
    delivery("duplicate-job", message.id, 2),
  ]);
  await worker.queue(batch, bindings);
  const result = await getQueueResult(batch, createExecutionContext());
  expect(result.explicitAcks).toEqual(["first-job", "duplicate-job"]);
  expect(result.retryMessages).toEqual([]);
  expect((await messageStatus(message.id))?.status).toBe("ready");
  expect(await bindings.MAIL.head(message.key)).not.toBeNull();
  expect(
    await bindings.DB.prepare(
      "SELECT count(*) AS count FROM events WHERE name = 'message.received' AND json_extract(data, '$.message_id') = ?",
    )
      .bind(message.id)
      .first("count"),
  ).toBe(1);
});
