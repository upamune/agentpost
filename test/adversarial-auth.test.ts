import { applyD1Migrations, createExecutionContext, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { beforeEach, expect, test } from "vitest";
import { z } from "zod";
import app from "../src/api";
import worker from "../src/index";
import { eventPollPageSchema } from "../src/event-schema";
import { sha256 } from "../src/common";
import type { Env } from "../src/types";

const bindings: Env = env;
const admin = "test-admin-token-with-at-least-32-characters";

beforeEach(async () => {
  await reset();
  await applyD1Migrations(bindings.DB, env.TEST_MIGRATIONS);
});

async function api(path: string, token: string, method = "GET", body?: unknown) {
  const init: RequestInit = {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return worker.fetch(
    new Request(`https://mail.test${path}`, init),
    bindings,
    createExecutionContext(),
  );
}

async function inbox() {
  const result = await api("/v1/inboxes", admin, "POST", {});
  expect(result.status).toBe(201);
  return result.json<{ id: string; token: string }>();
}

async function poll(token: string, cursor: string | null = null) {
  const response = await api("/v1/events/poll", token, "POST", {
    name: "message.received",
    cursor,
  });
  expect(response.status).toBe(200);
  return eventPollPageSchema.parse(await response.json());
}

test("idle inbox cursors conceal foreign activity with fixed size and fresh randomization", async () => {
  const own = await inbox();
  const foreign = await inbox();
  const before = await poll(own.token);
  const unchanged = await poll(own.token, before.cursor);
  expect(unchanged.events).toEqual([]);
  const messageId = "d".repeat(64);
  await bindings.DB.prepare(
    "INSERT INTO messages (id, inbox_id, raw_key, envelope_from, envelope_to, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(
      messageId,
      foreign.id,
      "raw/private.eml",
      "private@example.net",
      "private@example.com",
      Date.now(),
    )
    .run();
  await bindings.DB.prepare("UPDATE messages SET status = 'ready' WHERE id = ?")
    .bind(messageId)
    .run();
  // Exercise different sequence digit lengths without returning a foreign event.
  await bindings.DB.prepare("UPDATE events SET seq = 1000 WHERE inbox_id = ?")
    .bind(foreign.id)
    .run();
  const after = await poll(own.token, before.cursor);
  expect(after.events).toEqual([]);
  const cursors = [before.cursor, unchanged.cursor, after.cursor];
  expect(new Set(cursors).size).toBe(cursors.length);
  for (const cursor of cursors) {
    expect(cursor).toMatch(/^v2\.[a-zA-Z0-9_-]{91}$/);
    expect(cursor.length).toBe(94);
    const bytes = atob(`${cursor.slice(3).replaceAll("-", "+").replaceAll("_", "/")}=`);
    expect(bytes.length).toBe(68);
    expect(() => JSON.parse(bytes)).toThrow();
  }
});

test("rotated inbox credentials cannot access API or MCP or replay the old cursor", async () => {
  const own = await inbox();
  const cursor = (await poll(own.token)).cursor;
  const rotation = await api(`/v1/inboxes/${own.id}/token`, admin, "POST");
  expect(rotation.status).toBe(200);
  const fresh = await rotation.json<{ token: string }>();
  for (const path of [`/v1/inboxes/${own.id}`, "/v1/events", "/mcp"]) {
    expect((await api(path, own.token)).status).toBe(401);
  }
  expect((await api(`/v1/inboxes/${own.id}`, fresh.token)).status).toBe(200);
  expect(
    (await api("/v1/events/poll", fresh.token, "POST", { name: "message.received", cursor }))
      .status,
  ).toBe(400);
});

test("encoded and normalized inbox routes do not bypass per-inbox authorization", async () => {
  const own = await inbox();
  const foreign = await inbox();
  for (const path of [
    `/v1/inboxes/${foreign.id}`,
    `/v1/inboxes/${own.id}/../${foreign.id}`,
    `/v1/inboxes/${own.id}/%2e%2e/${foreign.id}`,
    `/v1/inboxes/${own.id}%2f..%2f${foreign.id}`,
    `/v1/inboxes/%252e%252e%252f${foreign.id}`,
    `/v1/inboxes/${foreign.id}%00`,
    `/v1/inboxes/${foreign.id}%2fmessages`,
    `/v1//inboxes/${foreign.id}`,
  ]) {
    const response = await api(path, own.token);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await response.text()).not.toContain(foreign.id);
  }
});

test("cursor IV, ciphertext, tag, encoding and foreign principal mutations are rejected", async () => {
  const own = await inbox();
  const cursor = (await poll(own.token)).cursor;
  const payload = cursor.slice(3);
  const bytes = Uint8Array.from(
    atob(`${payload.replaceAll("-", "+").replaceAll("_", "/")}=`),
    (character) => character.charCodeAt(0),
  );
  const mutations = [0, 12, 67].map((offset) => {
    const changed = bytes.slice();
    changed[offset] ^= 1;
    return `v2.${btoa(String.fromCharCode(...changed))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "")}`;
  });
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const noncanonical = `${cursor.slice(0, -1)}${alphabet[alphabet.indexOf(cursor.at(-1)!) + 1]}`;
  for (const forged of [
    ...mutations,
    noncanonical,
    `${cursor}=`,
    `${cursor}.`,
    `${cursor}..`,
    cursor.slice(0, -1),
    `v1.${payload}`,
    "a".repeat(2049),
    (await poll(admin)).cursor,
  ]) {
    expect(
      (
        await api("/v1/events/poll", own.token, "POST", {
          name: "message.received",
          cursor: forged,
        })
      ).status,
    ).toBe(400);
  }
});

test("valid legacy HMAC cursors are rejected without silently resetting the subscription", async () => {
  const own = await inbox();
  const tokenHash = await sha256(own.token);
  const scope = await sha256(
    JSON.stringify({ principal: tokenHash, name: "message.received", inboxId: own.id }),
  );
  const payload = btoa(JSON.stringify({ v: 1, seq: 0, scope }))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(admin),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = Array.from(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  const response = await api("/v1/events/poll", own.token, "POST", {
    name: "message.received",
    cursor: `${payload}.${mac}`,
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: "Invalid event cursor or cursor belongs to another subscription",
  });
});

test("admin secret rotation invalidates encrypted inbox cursors", async () => {
  const own = await inbox();
  const cursor = (await poll(own.token)).cursor;
  const response = await worker.fetch(
    new Request("https://mail.test/v1/events/poll", {
      method: "POST",
      headers: { Authorization: `Bearer ${own.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "message.received", cursor }),
    }),
    { ...bindings, AGENTPOST_ADMIN_TOKEN: "replacement-admin-token-with-32-characters" },
    createExecutionContext(),
  );
  expect(response.status).toBe(400);
});

test("unconfigured or placeholder admin credentials fail closed for inbox tokens too", async () => {
  const own = await inbox();
  for (const configured of ["", "replace-with-a-random-secret-at-least-32-characters", "short"]) {
    const response = await app.request(
      `https://mail.test/v1/inboxes/${own.id}`,
      { headers: { Authorization: `Bearer ${own.token}` } },
      { ...bindings, AGENTPOST_ADMIN_TOKEN: configured },
    );
    expect(response.status).toBe(503);
  }
});

test("an already-open MCP stream terminates after its inbox token is rotated", async () => {
  const own = await inbox();
  const client = new Client(
    { name: "adversarial-revocation-test", version: "1" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL("https://mail.test/mcp"), {
      requestInit: { headers: { Authorization: `Bearer ${own.token}` } },
      fetch: (url, init) =>
        worker.fetch(new Request(url, init), bindings, createExecutionContext()),
    }),
  );
  let activate!: () => void;
  const active = new Promise<void>((resolve) => {
    activate = resolve;
  });
  let terminate!: () => void;
  const terminated = new Promise<void>((resolve) => {
    terminate = resolve;
  });
  const notification = z.object({}).passthrough();
  client.setNotificationHandler("notifications/events/active", { params: notification }, activate);
  client.setNotificationHandler(
    "notifications/events/terminated",
    { params: notification },
    terminate,
  );
  const abort = new AbortController();
  const stream = client.request(
    { method: "events/stream", params: { name: "message.received" } },
    z.object({ _meta: z.object({}) }),
    { signal: abort.signal, timeout: 15_000 },
  );
  void stream.catch(() => {});
  try {
    await active;
    expect((await api(`/v1/inboxes/${own.id}/token`, admin, "POST")).status).toBe(200);
    await terminated;
    await stream;
  } finally {
    abort.abort();
    await client.close();
  }
}, 20_000);
