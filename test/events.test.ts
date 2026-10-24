import { createExecutionContext, applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";
import { beforeEach, describe, expect, test } from "vitest";
import app from "../src/api";
import worker from "../src/index";
import { eventPollPageSchema } from "../src/event-schema";
import type { EventPollPage } from "../src/event-schema";
import { receive, parseMessage } from "../src/inbound";
import { deliver } from "../src/outbound";
import type { Env, Message } from "../src/types";

const bindings: Env = env;
const admin = "test-admin-token-with-at-least-32-characters";
const boxSchema = z.object({ id: z.uuid(), address: z.email(), token: z.string() });
type Box = z.output<typeof boxSchema>;

async function api(path: string, body?: unknown, token = admin): Promise<Response> {
  return app.request(
    `https://mail.test${path}`,
    {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    bindings,
  );
}

async function inbox(): Promise<Box> {
  return boxSchema.parse(await (await api("/v1/inboxes", {})).json());
}

async function incoming(box: Box, marker = crypto.randomUUID()): Promise<string> {
  const raw = `From: sender@example.net\r\nTo: ${box.address}\r\nSubject: Event test\r\nMessage-ID: <${marker}@example.net>\r\n\r\nUntrusted external content.\r\n`;
  await receive(
    {
      from: "sender@example.net",
      to: box.address,
      headers: new Headers(),
      rawSize: raw.length,
      raw: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(raw));
          controller.close();
        },
      }),
      setReject() {
        throw new Error("Mail rejected");
      },
      forward() {
        throw new Error("Unexpected forward");
      },
      reply() {
        throw new Error("Unexpected reply");
      },
    },
    bindings,
  );
  const message = await bindings.DB.prepare(
    "SELECT id FROM messages WHERE inbox_id = ? AND status = 'pending'",
  )
    .bind(box.id)
    .first<Message>();
  if (!message) throw new Error("Message not stored");
  await parseMessage(bindings, message.id);
  return message.id;
}

async function poll(
  cursor: string | null = null,
  options: {
    token?: string;
    inbox?: string;
    limit?: number;
    name?: string;
    maxAgeMs?: number;
  } = {},
): Promise<EventPollPage> {
  const response = await api(
    "/v1/events/poll",
    {
      name: options.name ?? "message.received",
      arguments: options.inbox ? { inbox_id: options.inbox } : {},
      cursor,
      maxEvents: options.limit ?? 25,
      ...(options.maxAgeMs === undefined ? {} : { maxAgeMs: options.maxAgeMs }),
    },
    options.token,
  );
  if (!response.ok) throw new Error(`Poll failed: ${response.status}`);
  return eventPollPageSchema.parse(await response.json());
}

async function mcpClient(token = admin, environment = bindings) {
  const client = new Client(
    { name: "agentpost-test", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  const transport = new StreamableHTTPClientTransport(new URL("https://mail.test/mcp"), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
    fetch: async (input, init) =>
      worker.fetch(new Request(input, init), environment, createExecutionContext()),
  });
  await client.connect(transport);
  return client;
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(bindings.DB, env.TEST_MIGRATIONS);
});

describe("durable event history", () => {
  test("null cursor starts now and replays subsequent events without bodies or duplicate emissions", async () => {
    const box = await inbox();
    await incoming(box);
    const start = await poll();
    expect(start.events).toEqual([]);
    const messageId = await incoming(box);
    const page = await poll(start.cursor);
    expect(page.events).toHaveLength(1);
    expect(page.events[0].data).toEqual({ inbox_id: box.id, message_id: messageId });
    expect(JSON.stringify(page.events)).not.toContain("Untrusted external content");
    await bindings.DB.prepare("UPDATE messages SET status = 'pending' WHERE id = ?")
      .bind(messageId)
      .run();
    await parseMessage(bindings, messageId);
    expect((await poll(page.cursor)).events).toEqual([]);
    expect((await poll(start.cursor)).events.map((event) => event.eventId)).toEqual(
      page.events.map((event) => event.eventId),
    );
  });

  test("event and state transition roll back together if their transaction fails", async () => {
    const box = await inbox();
    await incoming(box);
    await bindings.DB.prepare("DELETE FROM events").run();
    await bindings.DB.prepare("UPDATE messages SET status = 'pending'").run();
    await expect(
      bindings.DB.batch([
        bindings.DB.prepare("UPDATE messages SET status = 'ready'"),
        bindings.DB.prepare(
          "INSERT INTO inboxes (id, address, label, token_hash, created_at) SELECT id, address, label, token_hash, created_at FROM inboxes",
        ),
      ]),
    ).rejects.toThrow();
    expect((await bindings.DB.prepare("SELECT count(*) AS total FROM events").first())?.total).toBe(
      0,
    );
    expect((await bindings.DB.prepare("SELECT status FROM messages").first())?.status).toBe(
      "pending",
    );
  });

  test("paginated replay preserves all events and cursors resume after individual push deliveries", async () => {
    const box = await inbox();
    const start = await poll();
    await incoming(box);
    await incoming(box);
    await incoming(box);
    const first = await poll(start.cursor, { limit: 2 });
    expect(first.hasMore).toBe(true);
    expect(first.events).toHaveLength(2);
    const rest = await poll(first.cursor, { limit: 2 });
    expect(rest.events).toHaveLength(1);
    expect(rest.hasMore).toBe(false);
    expect(new Set([...first.events, ...rest.events].map((event) => event.eventId)).size).toBe(3);
    expect((await poll(first.eventCursors[0])).events).toHaveLength(2);
    expect(first.startCursor).toBe(start.cursor);
  });

  test("inbox tokens cannot see another inbox or reuse another principal's cursor", async () => {
    const a = await inbox();
    const b = await inbox();
    const start = await poll(null, { token: a.token });
    await incoming(a);
    await incoming(b);
    const own = await poll(start.cursor, { token: a.token });
    expect(own.events).toHaveLength(1);
    expect(own.events[0].data.inbox_id).toBe(a.id);
    expect(
      (
        await api(
          "/v1/events/poll",
          { name: "message.received", arguments: { inbox_id: b.id } },
          a.token,
        )
      ).status,
    ).toBe(403);
    expect(
      (await api("/v1/events/poll", { name: "message.received", cursor: start.cursor }, b.token))
        .status,
    ).toBe(400);
  });

  test("rejects forged cursors and cursors for different event types", async () => {
    const start = await poll();
    expect(
      (await api("/v1/events/poll", { name: "message.received", cursor: `${start.cursor}x` }))
        .status,
    ).toBe(400);
    expect(
      (await api("/v1/events/poll", { name: "message.send_status_changed", cursor: start.cursor }))
        .status,
    ).toBe(400);
    expect((await api("/v1/events/poll", { name: "nonexistent" })).status).toBe(404);
  });

  test("maxAgeMs and database rollback gaps are explicitly reported", async () => {
    const box = await inbox();
    const start = await poll();
    await incoming(box);
    await bindings.DB.prepare("UPDATE events SET created_at = ?")
      .bind(Date.now() - 60_000)
      .run();
    const skipped = await poll(start.cursor, { maxAgeMs: 1000 });
    expect(skipped.events).toEqual([]);
    expect(skipped.truncated).toBe(true);
    await bindings.DB.prepare("DELETE FROM events").run();
    const restored = await poll(skipped.cursor);
    expect(restored.truncated).toBe(true);
    expect(restored.events).toEqual([]);
  });

  test("send status notifications describe acceptance without claiming delivery", async () => {
    const box = await inbox();
    const start = await poll(null, { name: "message.send_status_changed" });
    const response = await app.request(
      `https://mail.test/v1/inboxes/${box.id}/send`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${box.token}`,
          "Content-Type": "application/json",
          "Idempotency-Key": "event-send",
        },
        body: JSON.stringify({ to: ["recipient@example.net"], subject: "Test", text: "Body" }),
      },
      bindings,
    );
    const { id } = z.object({ id: z.string() }).parse(await response.json());
    await deliver(bindings, id, async () => ({ status: "accepted", result: "{}" }));
    const page = await poll(start.cursor, { name: "message.send_status_changed" });
    expect(page.events[0].data).toEqual({ inbox_id: box.id, send_id: id, status: "accepted" });
  });
});

describe("modern remote MCP", () => {
  test("MCP send tools cannot bypass the inbox send limiter", async () => {
    const box = await inbox();
    const client = await mcpClient(box.token, {
      ...bindings,
      AGENTPOST_SEND_LIMITER: { limit: async () => ({ success: false }) },
    });
    try {
      const result = await client.callTool({
        name: "send_email",
        arguments: {
          inbox_id: box.id,
          to: ["test@example.net"],
          subject: "Test",
          text: "Body",
          idempotency_key: "mcp-limited",
        },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("HTTP 429");
      expect(
        (await bindings.DB.prepare("SELECT count(*) AS total FROM outbox").first())?.total,
      ).toBe(0);
    } finally {
      await client.close();
    }
  });

  test("requires authentication and rejects cross-origin requests", async () => {
    const context = createExecutionContext();
    expect(
      (await worker.fetch(new Request("https://mail.test/mcp"), bindings, context)).status,
    ).toBe(401);
    expect(
      (
        await worker.fetch(
          new Request("https://mail.test/mcp", {
            headers: { Authorization: `Bearer ${admin}`, Origin: "https://evil.test" },
          }),
          bindings,
          context,
        )
      ).status,
    ).toBe(403);
  });

  test("negotiates 2026-07-28 and discovers and polls MCP Events through the deployed handler", async () => {
    const client = await mcpClient();
    try {
      expect(client.getProtocolEra()).toBe("modern");
      expect(client.getServerVersion()?.name).toBe("agentpost");
      expect(
        client.getServerCapabilities()?.extensions?.["io.modelcontextprotocol/events"],
      ).toBeDefined();
      const listed = await client.request(
        { method: "events/list", params: {} },
        z.object({
          events: z.array(z.object({ name: z.string(), delivery: z.array(z.string()) })),
        }),
      );
      expect(listed.events.map((event) => event.name)).toContain("message.received");
      const result = await client.request(
        { method: "events/poll", params: { name: "message.received" } },
        z.object({ events: z.array(z.unknown()), cursor: z.string() }),
      );
      expect(result.events).toEqual([]);
    } finally {
      await client.close();
    }
  });

  test("push streams deliver correlated events and cancellation releases the subscription", async () => {
    const client = await mcpClient();
    const box = await inbox();
    const controller = new AbortController();
    let activeResolve!: () => void;
    const active = new Promise<void>((resolve) => {
      activeResolve = resolve;
    });
    let eventResolve!: (value: Record<string, unknown>) => void;
    const event = new Promise<Record<string, unknown>>((resolve) => {
      eventResolve = resolve;
    });
    let heartbeatResolve!: (value: Record<string, unknown>) => void;
    const heartbeat = new Promise<Record<string, unknown>>((resolve) => {
      heartbeatResolve = resolve;
    });
    const metadata = z.object({ _meta: z.record(z.string(), z.unknown()) }).passthrough();
    client.setNotificationHandler("notifications/events/active", { params: metadata }, () =>
      activeResolve(),
    );
    client.setNotificationHandler("notifications/events/event", { params: metadata }, (params) =>
      eventResolve(params),
    );
    client.setNotificationHandler(
      "notifications/events/heartbeat",
      { params: metadata },
      (params) => heartbeatResolve(params),
    );
    const stream = client.request(
      {
        method: "events/stream",
        params: { name: "message.received", arguments: { inbox_id: box.id } },
      },
      z.object({ _meta: z.object({}) }),
      { signal: controller.signal, timeout: 60_000 },
    );
    void stream.catch(() => {});
    try {
      await Promise.race([
        active,
        stream.then(() => {
          throw new Error("Stream ended before activation");
        }),
      ]);
      const id = await incoming(box);
      const notification = await event;
      expect(notification.eventId).toBe(`message.received:${id}`);
      expect(
        metadata.parse(notification)._meta["io.modelcontextprotocol/subscriptionId"],
      ).toBeDefined();
      expect(notification.cursor).toEqual(expect.any(String));
      const keepalive = await Promise.race([
        heartbeat,
        stream.then(() => {
          throw new Error("Stream ended before heartbeat");
        }),
      ]);
      expect(keepalive.cursor).toBe(notification.cursor);
      controller.abort();
      await expect(stream).rejects.toThrow();
    } finally {
      controller.abort();
      await client.close();
    }
  }, 30_000);
});
