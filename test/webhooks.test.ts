import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { createHmac } from "node:crypto";
import app from "../src/api";
import { coordinator } from "../src/coordinator";
import { parseMessage, receive } from "../src/inbound";
import { createWebhookConfig, readWebhookConfig } from "../src/webhook-crypto";
import { webhookTarget } from "../src/webhook-policy";
import { processWebhook } from "../src/webhook-delivery";
import { publicWebhook, publishMessageWebhooks, saveWebhook } from "../src/webhook-store";
import { deliverWebhook, republishWebhooks } from "../src/webhooks";
import type { WebhookDelivery, WebhookRow } from "../src/webhook-store";
import type { Env } from "../src/types";

const bindings: Env = env;
const admin = "test-admin-token-with-at-least-32-characters";
type Box = { id: string; token: string; address: string };
async function request(
  path: string,
  method = "GET",
  body?: unknown,
  token = admin,
  extra: Partial<Env> = {},
) {
  return app.request(
    `https://api.example.org/v1${path}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    { ...bindings, ...extra },
  );
}
async function box(): Promise<Box> {
  return (await request("/inboxes", "POST", { label: "webhook" })).json();
}
async function configure(inbox: Box) {
  const response = await request(
    `/inboxes/${inbox.id}/webhook`,
    "PUT",
    { url: "https://receiver.example.org/receive?opaque=private" },
    inbox.token,
  );
  expect(response.status).toBe(200);
  return response.json() as Promise<{ id: string; secret: string; url: string }>;
}
async function message(inbox: Box) {
  const raw = `From: sender@example.org\r\nTo: ${inbox.address}\r\nSubject: Private content\r\nContent-Type: text/plain\r\n\r\nsecret body`;
  await receive(
    {
      headers: new Headers(),
      forward: async () => {
        throw new Error("Unexpected forwarding");
      },
      reply: async () => {
        throw new Error("Unexpected reply");
      },
      from: "sender@example.org",
      to: inbox.address,
      rawSize: raw.length,
      raw: new Response(raw).body!,
      setReject(reason: string) {
        throw new Error(reason);
      },
    },
    bindings,
  );
  const row = await bindings.DB.prepare("SELECT id FROM messages WHERE inbox_id = ?")
    .bind(inbox.id)
    .first<{ id: string }>();
  await parseMessage(bindings, row!.id);
  return row!.id;
}
async function delivery(messageId: string) {
  return (await bindings.DB.prepare("SELECT * FROM webhook_deliveries WHERE message_id = ?")
    .bind(messageId)
    .first<WebhookDelivery>())!;
}
function fetchMock(status = 204) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status }));
}
beforeEach(async () => {
  await reset();
  await applyD1Migrations(bindings.DB, env.TEST_MIGRATIONS);
});
afterEach(() => vi.restoreAllMocks());

test("configuration is inbox scoped, encrypted, authenticated to identity, secret returned only once", async () => {
  const a = await box(),
    b = await box();
  const config = await configure(a);
  expect(config.secret).toMatch(/^whsec_/);
  expect((await request(`/inboxes/${a.id}/webhook`, "GET", undefined, b.token)).status).toBe(404);
  const row = await bindings.DB.prepare("SELECT * FROM inbox_webhooks WHERE inbox_id = ?")
    .bind(a.id)
    .first<WebhookRow>();
  expect(row!.encrypted_config).not.toContain("private");
  expect(row!.encrypted_config).not.toContain(config.secret);
  const visible = await publicWebhook(bindings, a.id);
  expect(visible).not.toHaveProperty("secret");
  expect(visible).not.toHaveProperty("encrypted_config");
  await expect(
    readWebhookConfig(bindings, b.id, config.id, row!.encrypted_config!),
  ).rejects.toThrow("cannot be decrypted");
  const newConfig = await configure(a);
  expect(newConfig.secret).not.toBe(config.secret);
});

test("atomic ready capture, duplicate processing and signed metadata only notification", async () => {
  const a = await box();
  const config = await configure(a);
  const id = await message(a);
  await parseMessage(bindings, id);
  const row = await delivery(id);
  expect(row.webhook_id).toBe(config.id);
  let body = "";
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    body = await (input as Request).text();
    return new Response(null, { status: 204 });
  });
  await deliverWebhook(bindings, row.id);
  await deliverWebhook(bindings, row.id);
  expect(fetch).toHaveBeenCalledTimes(1);
  const req = fetch.mock.calls[0]![0] as Request;
  expect(JSON.parse(body)).toEqual({
    event_id: `message.received:${id}`,
    type: "message.received",
    timestamp: new Date(row.created_at).toISOString(),
    data: { inbox_id: a.id, message_id: id },
  });
  expect(body).not.toContain("secret body");
  expect(body).not.toContain("sender@example.org");
  const timestamp = req.headers.get("webhook-timestamp")!;
  expect(req.headers.get("webhook-signature")).toBe(
    `v1,${createHmac("sha256", Buffer.from(config.secret.slice(6), "base64"))
      .update(`${row.id}.${timestamp}.${body}`, "utf8")
      .digest("base64")}`,
  );
  expect(req.headers.get("authorization")).toBeNull();
  expect(req.redirect).toBe("manual");
  expect((await delivery(id)).status).toBe("delivered");
});

test("replaced configuration cancels old delivery and never retargets old events", async () => {
  const a = await box();
  await configure(a);
  const id = await message(a);
  const old = await delivery(id);
  await configure(a);
  expect((await delivery(id)).status).toBe("cancelled");
  const fetch = fetchMock();
  await deliverWebhook(bindings, old.id);
  expect(fetch).not.toHaveBeenCalled();
  await request(`/inboxes/${a.id}/webhook`, "DELETE", undefined, a.token);
  expect(await publicWebhook(bindings, a.id)).toMatchObject({ enabled: false });
});

test("disable blocks dispatch; tombstone prevents stale config resurrection", async () => {
  const a = await box();
  await configure(a);
  const id = await message(a);
  const row = await delivery(id);
  await coordinator(bindings, a.id).setActive(a.id, false);
  const fetch = fetchMock();
  await deliverWebhook(bindings, row.id);
  expect(fetch).not.toHaveBeenCalled();
  expect((await delivery(id)).status).toBe("cancelled");
  await coordinator(bindings, a.id).setActive(a.id, true);
  const stale = await createWebhookConfig(bindings, a.id, "https://receiver.example.org/stale");
  await coordinator(bindings, a.id).setWebhook(a.id, null);
  expect(await saveWebhook(bindings, a.id, stale.id, stale.encrypted, 1)).toBe(false);
  expect(await publicWebhook(bindings, a.id)).toMatchObject({ enabled: false });
});

test("failed queue publication retains ready mail and pending delivery for cron rescue", async () => {
  const a = await box();
  await configure(a);
  const id = await message(a);
  const queue = { send: vi.fn().mockRejectedValue(new Error("queue unavailable")) };
  const unavailable = { ...bindings, AGENTPOST_WEBHOOK_JOBS: queue } as unknown as Env;
  await expect(publishMessageWebhooks(unavailable, id)).rejects.toThrow(
    "durable delivery retained",
  );
  expect((await delivery(id)).status).toBe("pending");
  const sendBatch = vi.fn().mockResolvedValue(undefined);
  await republishWebhooks({ ...bindings, AGENTPOST_WEBHOOK_JOBS: { sendBatch } } as unknown as Env);
  expect(sendBatch).toHaveBeenCalledWith([
    { body: { kind: "webhook", id: (await delivery(id)).id } },
  ]);
  expect(await bindings.MAIL.get(`parsed/${id}.json`)).not.toBeNull();
});

test("retry uses same delivery identity and claims; old settlement cannot overwrite a newer claim", async () => {
  const a = await box();
  await configure(a);
  const id = await message(a);
  const row = await delivery(id);
  const fetch = fetchMock(503);
  await deliverWebhook(bindings, row.id);
  expect(await delivery(id)).toMatchObject({ status: "pending", attempts: 1 });
  await bindings.DB.prepare("UPDATE webhook_deliveries SET available_at = 0 WHERE id = ?")
    .bind(row.id)
    .run();
  fetch.mockImplementation(async () => {
    await bindings.DB.prepare(
      "UPDATE webhook_deliveries SET claim_token = 'newer-claim' WHERE id = ?",
    )
      .bind(row.id)
      .run();
    return new Response(null, { status: 204 });
  });
  await deliverWebhook(bindings, row.id);
  expect(await delivery(id)).toMatchObject({
    status: "sending",
    claim_token: "newer-claim",
    attempts: 2,
  });
});

test("ownership fence failure never initiates fetch or becomes an automatic retry", async () => {
  const a = await box();
  await configure(a);
  const id = await message(a);
  const row = await delivery(id);
  const fetch = fetchMock();
  await expect(
    processWebhook(
      bindings,
      row.id,
      a.id,
      () => {
        throw new Error("replaced actor");
      },
      async () => true,
    ),
  ).rejects.toThrow("replaced actor");
  expect(fetch).not.toHaveBeenCalled();
  expect((await delivery(id)).status).toBe("sending");
});

test("bounded retries and redirect rejection", async () => {
  const a = await box();
  await configure(a);
  const id = await message(a);
  const row = await delivery(id);
  const fetch = fetchMock(302);
  await deliverWebhook(bindings, row.id);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect((await delivery(id)).status).toBe("failed");
  await bindings.DB.prepare(
    "UPDATE webhook_deliveries SET status='sending', attempts=8, updated_at=0 WHERE id=?",
  )
    .bind(row.id)
    .run();
  await deliverWebhook(bindings, row.id);
  expect((await delivery(id)).status).toBe("failed");
  expect(fetch).toHaveBeenCalledTimes(1);
});

test("policy rejects arbitrary URLs and disabled configuration without outbound I/O", async () => {
  for (const url of [
    "http://receiver.example.org/",
    "https://localhost/",
    "https://127.0.0.1/",
    "https://[::1]/",
    "https://receiver.example.org:8443/",
    "https://user:secret@receiver.example.org/",
    "https://receiver.example.org/#secret",
    "https://untrusted.example.org/",
  ]) {
    expect(() => webhookTarget(bindings, url)).toThrow();
  }
  const a = await box();
  expect(
    (
      await request(
        `/inboxes/${a.id}/webhook`,
        "PUT",
        { url: "https://receiver.example.org/" },
        admin,
        { AGENTPOST_WEBHOOK_ALLOWED_ORIGINS: "[]" },
      )
    ).status,
  ).toBe(503);
});

test("API auto-generates a distinct UUIDv4 for omitted send keys and returns response header", async () => {
  const a = await box();
  const body = { to: ["recipient@example.org"], subject: "Key", text: "Hello" };
  const one = await request(`/inboxes/${a.id}/send`, "POST", body, a.token);
  const two = await request(`/inboxes/${a.id}/send`, "POST", body, a.token);
  const first = (await one.json()) as { idempotency_key: string; id: string };
  const second = (await two.json()) as { idempotency_key: string; id: string };
  expect(first.idempotency_key).toMatch(
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  );
  expect(one.headers.get("Idempotency-Key")).toBe(first.idempotency_key);
  expect(second.id).not.toBe(first.id);
});
