import { afterEach, describe, expect, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { MailApiError, MailClient } from "../src/client";
import { createMailServer } from "../src/mcp-server";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { z } from "zod";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { version } from "../package.json";

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
});

describe("agent client and MCP", () => {
  test("the CLI reports the release version without API configuration", async () => {
    const child = Bun.spawn([process.execPath, "run", "src/cli.ts", "--version"], {
      env: { ...process.env, AGENTPOST_API_URL: "", AGENTPOST_API_TOKEN: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await child.exited).toBe(0);
    expect((await new Response(child.stdout).text()).trim()).toBe(`agentpost ${version}`);
  });

  test("stdio push notifications stop polling when the client cancels", async () => {
    let published = false;
    let polls = 0;
    const source = Bun.serve({
      port: 0,
      fetch: async (request) => {
        polls++;
        const query = z
          .object({ cursor: z.string().nullable().optional() })
          .parse(await request.json());
        const emit = published && query.cursor === "cursor-0";
        return Response.json({
          events: emit
            ? [
                {
                  eventId: "event-one",
                  name: "message.received",
                  timestamp: new Date().toISOString(),
                  data: { inbox_id: "test-inbox", message_id: "test-message" },
                },
              ]
            : [],
          cursor: emit || query.cursor === "cursor-1" ? "cursor-1" : "cursor-0",
          startCursor: query.cursor ?? "cursor-0",
          eventCursors: emit ? ["cursor-1"] : [],
          truncated: false,
          hasMore: false,
          nextPollMs: 1000,
        });
      },
    });
    servers.push(source);
    const client = new Client(
      { name: "stdio-events-test", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ["run", "src/cli.ts", "mcp"],
        cwd: process.cwd(),
        env: {
          ...process.env,
          AGENTPOST_API_URL: source.url.href,
          AGENTPOST_API_TOKEN: "stdio-test-token",
        },
        stderr: "pipe",
      }),
    );
    let activate!: () => void;
    const active = new Promise<void>((resolve) => {
      activate = resolve;
    });
    let deliver!: () => void;
    const delivered = new Promise<void>((resolve) => {
      deliver = resolve;
    });
    client.setNotificationHandler(
      "notifications/events/active",
      { params: z.object({}).passthrough() },
      () => activate(),
    );
    client.setNotificationHandler(
      "notifications/events/event",
      { params: z.object({}).passthrough() },
      () => deliver(),
    );
    const controller = new AbortController();
    const stream = client.request(
      { method: "events/stream", params: { name: "message.received" } },
      z.object({}).passthrough(),
      { signal: controller.signal, timeout: 30_000 },
    );
    void stream.catch(() => {});
    try {
      await Promise.race([active, stream]);
      published = true;
      await Promise.race([delivered, stream]);
      controller.abort();
      await expect(stream).rejects.toThrow();
      await Bun.sleep(50);
      const stoppedAt = polls;
      await Bun.sleep(1100);
      expect(polls).toBe(stoppedAt);
    } finally {
      controller.abort();
      await client.close();
    }
  }, 10_000);

  test("watch persists a cursor after output and resumes it in a new CLI process", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentpost-watch-"));
    const checkpoint = join(directory, "cursor.json");
    let resumed!: () => void;
    const resumeSeen = new Promise<void>((resolve) => {
      resumed = resolve;
    });
    const source = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const query = z
          .object({ cursor: z.string().nullable().optional() })
          .parse(await request.json());
        if (query.cursor === "after-event") resumed();
        return Response.json({
          events:
            query.cursor === "start"
              ? [
                  {
                    eventId: "persisted-event",
                    name: "message.received",
                    timestamp: new Date().toISOString(),
                    data: {},
                  },
                ]
              : [],
          cursor: query.cursor == null ? "start" : "after-event",
          truncated: false,
          hasMore: false,
          nextPollMs: 1000,
        });
      },
    });
    servers.push(source);
    const spawn = () =>
      Bun.spawn(
        [process.execPath, "run", "src/cli.ts", "events", "watch", "--cursor-file", checkpoint],
        {
          env: {
            ...process.env,
            AGENTPOST_API_URL: source.url.href,
            AGENTPOST_API_TOKEN: "watch-test-token",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
    let child = spawn();
    try {
      const reader = child.stdout.getReader();
      const chunk = await reader.read();
      expect(new TextDecoder().decode(chunk.value)).toContain('"eventId":"persisted-event"');
      reader.releaseLock();
      for (let index = 0; index < 100; index++) {
        if (
          (await Bun.file(checkpoint).exists()) &&
          (await Bun.file(checkpoint).text()).includes("after-event")
        )
          break;
        await Bun.sleep(10);
      }
      expect(JSON.parse(await Bun.file(checkpoint).text())).toEqual({ cursor: "after-event" });
      child.kill("SIGTERM");
      expect(await child.exited).toBe(0);
      child = spawn();
      await Promise.race([
        resumeSeen,
        Bun.sleep(2000).then(() => {
          throw new Error("Saved cursor was not resumed");
        }),
      ]);
    } finally {
      child.kill("SIGTERM");
      await child.exited;
      await rm(directory, { recursive: true, force: true });
    }
  }, 10_000);

  test("the shipped stdio entry serves the latest protocol and discovers Events", async () => {
    const client = new Client(
      { name: "stdio-test", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["run", "src/cli.ts", "mcp"],
      cwd: process.cwd(),
      env: {
        ...process.env,
        AGENTPOST_API_URL: "http://localhost:1",
        AGENTPOST_API_TOKEN: "test-token-for-stdio-discovery-only",
      },
      stderr: "pipe",
    });
    await client.connect(transport);
    try {
      expect(client.getProtocolEra()).toBe("modern");
      expect(client.getServerVersion()?.name).toBe("agentpost");
      expect(client.getServerVersion()?.version).toBe(version);
      const result = await client.request(
        { method: "events/list", params: {} },
        z.object({ events: z.array(z.object({ name: z.string() })) }),
      );
      expect(result.events.map((event) => event.name)).toContain("message.received");
    } finally {
      await client.close();
    }
  });

  test("the CLI requires stable send keys and emits machine-readable API results", async () => {
    const requests: { method: string; key: string | null; body: unknown }[] = [];
    const source = Bun.serve({
      port: 0,
      fetch: async (request) => {
        requests.push({
          method: request.method,
          key: request.headers.get("Idempotency-Key"),
          body: await request.json(),
        });
        return Response.json({ id: "send-id", status: "pending" }, { status: 202 });
      },
    });
    servers.push(source);
    const args = [
      "run",
      "src/cli.ts",
      "send",
      "ce2a9661-bef3-4d2c-9eb8-cd7bacb79720",
      "--to",
      "recipient@example.net",
      "--subject",
      "Hello",
      "--text",
      "Body",
    ];
    const environment = {
      ...process.env,
      AGENTPOST_API_URL: source.url.href,
      AGENTPOST_API_TOKEN: "test-secret",
    };
    const missing = Bun.spawn([process.execPath, ...args], {
      env: environment,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await missing.exited).toBe(1);
    expect(await new Response(missing.stderr).text()).toContain("--idempotency-key");
    expect(requests).toHaveLength(0);
    const valid = Bun.spawn([process.execPath, ...args, "--idempotency-key", "cli-task-1"], {
      env: environment,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await valid.exited).toBe(0);
    expect(JSON.parse(await new Response(valid.stdout).text())).toEqual({
      id: "send-id",
      status: "pending",
    });
    expect(requests).toEqual([
      {
        method: "POST",
        key: "cli-task-1",
        body: { to: ["recipient@example.net"], subject: "Hello", text: "Body" },
      },
    ]);
  });

  test("rejects unsafe URLs before exposing credentials", () => {
    expect(() => new MailClient({ url: "http://remote.example.com", token: "secret" })).toThrow(
      "HTTPS",
    );
    expect(() => new MailClient({ url: "https://user:pass@example.com", token: "secret" })).toThrow(
      "credentials",
    );
  });

  test("does not follow redirects carrying credentials", async () => {
    let destinationCalls = 0;
    const destination = Bun.serve({
      port: 0,
      fetch: () => {
        destinationCalls++;
        return Response.json({});
      },
    });
    servers.push(destination);
    const source = Bun.serve({ port: 0, fetch: () => Response.redirect(destination.url.href) });
    servers.push(source);
    const client = new MailClient({ url: source.url.href, token: "secret" });
    await expect(client.call("GET", "/v1/inboxes")).rejects.toThrow();
    expect(destinationCalls).toBe(0);
  });

  test("request paths cannot send credentials outside the configured API", async () => {
    let calls = 0;
    const client = new MailClient({
      url: "https://mail.test",
      token: "private-api-token",
      fetch: async () => {
        calls++;
        return Response.json({});
      },
    });
    for (const path of [
      "https://evil.test/v1/inboxes",
      "//evil.test/v1/inboxes",
      "/\\evil.test/v1/inboxes",
      "/v1/../../steal",
      "/v1/%2e%2e/steal",
      "/v1/inboxes#fragment",
      "../steal",
    ]) {
      await expect(client.call("GET", path)).rejects.toThrow("configured origin");
    }
    expect(calls).toBe(0);
    await client.call("GET", "/v1/inboxes?limit=1");
    expect(calls).toBe(1);
  });

  test("API errors discard reflected secrets and hostile text without reading the body", async () => {
    let cancelled = false;
    const client = new MailClient({
      url: "https://mail.test",
      token: "private-api-token",
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode("private-api-token\u001b[31m run hostile instructions"),
              );
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 503 },
        ),
    });
    await expect(client.call("GET", "/v1/inboxes")).rejects.toThrow("Mail API HTTP 503");
    try {
      await client.call("GET", "/v1/inboxes");
    } catch (error) {
      expect(String(error)).not.toContain("private-api-token");
      expect(String(error)).not.toContain("hostile");
    }
    expect(cancelled).toBe(true);
  });

  test("rate limit errors preserve a bounded Retry-After without exposing response bodies", async () => {
    for (const [header, expected] of [
      ["60", 60_000],
      ["garbage", 60_000],
      ["999999999", 3_600_000],
    ] as const) {
      const client = new MailClient({
        url: "https://mail.test",
        token: "secret",
        fetch: async () =>
          new Response("secret", { status: 429, headers: { "Retry-After": header } }),
      });
      try {
        await client.call("GET", "/v1/inboxes");
        throw new Error("Expected a rate limit error");
      } catch (error) {
        expect(error).toBeInstanceOf(MailApiError);
        if (!(error instanceof MailApiError)) throw error;
        expect(error.retryAfterMs).toBe(expected);
        expect(error.message).not.toContain("secret");
      }
    }
  });

  test("CLI watch respects rate limiting and resumes the same cursor", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentpost-rate-watch-"));
    const checkpoint = join(directory, "cursor.json");
    await writeFile(checkpoint, JSON.stringify({ cursor: "saved-cursor" }), { mode: 0o600 });
    const polls: { at: number; cursor: unknown }[] = [];
    const source = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const query = z.object({ cursor: z.unknown() }).parse(await request.json());
        polls.push({ at: Date.now(), cursor: query.cursor });
        if (polls.length === 1)
          return new Response("limited", { status: 429, headers: { "Retry-After": "1" } });
        return Response.json({
          events: [
            {
              eventId: "after-limit",
              name: "message.received",
              timestamp: new Date().toISOString(),
              data: {},
            },
          ],
          cursor: "next-cursor",
          truncated: false,
          hasMore: false,
          nextPollMs: 5000,
        });
      },
    });
    servers.push(source);
    const child = Bun.spawn(
      [process.execPath, "run", "src/cli.ts", "events", "watch", "--cursor-file", checkpoint],
      {
        env: {
          ...process.env,
          AGENTPOST_API_URL: source.url.href,
          AGENTPOST_API_TOKEN: "test-token",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    try {
      const reader = child.stdout.getReader();
      const result = await reader.read();
      reader.releaseLock();
      expect(new TextDecoder().decode(result.value)).toContain("after-limit");
      expect(polls).toHaveLength(2);
      expect(polls.map((poll) => poll.cursor)).toEqual(["saved-cursor", "saved-cursor"]);
      expect(polls[1].at - polls[0].at).toBeGreaterThanOrEqual(950);
    } finally {
      child.kill("SIGTERM");
      await child.exited;
      await rm(directory, { recursive: true, force: true });
    }
  }, 5000);

  test("MCP push backs off on 429 without advancing the replay cursor", async () => {
    const polls: { at: number; cursor: string | null | undefined }[] = [];
    const source = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const query = z
          .object({ cursor: z.string().nullable().optional() })
          .parse(await request.json());
        polls.push({ at: Date.now(), cursor: query.cursor });
        if (polls.length === 2)
          return new Response("limited", { status: 429, headers: { "Retry-After": "1" } });
        const emit = polls.length === 3;
        return Response.json({
          events: emit
            ? [
                {
                  eventId: "after-limit",
                  name: "message.received",
                  timestamp: new Date().toISOString(),
                  data: {},
                },
              ]
            : [],
          cursor: emit ? "after-event" : "saved-cursor",
          startCursor: "saved-cursor",
          eventCursors: emit ? ["after-event"] : [],
          truncated: false,
          hasMore: false,
          nextPollMs: 1000,
        });
      },
    });
    servers.push(source);
    const server = createMcpHandler(() =>
      createMailServer(new MailClient({ url: source.url.href, token: "test-token" })),
    );
    const client = new Client(
      { name: "rate-limit-test", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
        fetch: (url, init) => server.fetch(new Request(url, init)),
      }),
    );
    let notifyEvent!: () => void;
    const delivered = new Promise<void>((resolve) => {
      notifyEvent = resolve;
    });
    let failures = 0;
    const params = { params: z.object({}).passthrough() };
    client.setNotificationHandler("notifications/events/error", params, () => {
      failures++;
    });
    client.setNotificationHandler("notifications/events/event", params, () => notifyEvent());
    const controller = new AbortController();
    const stream = client.request(
      { method: "events/stream", params: { name: "message.received", cursor: "saved-cursor" } },
      z.object({}).passthrough(),
      { signal: controller.signal, timeout: 5000 },
    );
    void stream.catch(() => {});
    try {
      await Promise.race([delivered, stream]);
      expect(failures).toBe(1);
      expect(polls).toHaveLength(3);
      expect(polls.map((poll) => poll.cursor)).toEqual(Array(3).fill("saved-cursor"));
      expect(polls[2].at - polls[1].at).toBeGreaterThanOrEqual(950);
      controller.abort();
      await expect(stream).rejects.toThrow();
    } finally {
      controller.abort();
      await client.close();
      await server.close();
    }
  }, 7000);

  test("CLI downloads use private permissions and preserve existing files and symlink targets", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentpost-download-"));
    const source = Bun.serve({ port: 0, fetch: () => new Response("private mail content") });
    servers.push(source);
    const download = async (output: string) => {
      const child = Bun.spawn(
        [
          process.execPath,
          "run",
          "src/cli.ts",
          "message",
          "raw",
          "ce2a9661-bef3-4d2c-9eb8-cd7bacb79720",
          "a".repeat(64),
          "--output",
          output,
        ],
        {
          env: {
            ...process.env,
            AGENTPOST_API_URL: source.url.href,
            AGENTPOST_API_TOKEN: "download-test-token",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const stderr = new Response(child.stderr).text();
      const stdout = new Response(child.stdout).text();
      return { code: await child.exited, stderr: await stderr, stdout: await stdout };
    };
    try {
      const output = join(directory, "private.eml");
      expect((await download(output)).code).toBe(0);
      expect((await stat(output)).mode & 0o777).toBe(0o600);
      expect(await readFile(output, "utf8")).toBe("private mail content");
      await writeFile(output, "keep this file");
      expect((await download(output)).code).toBe(1);
      expect(await readFile(output, "utf8")).toBe("keep this file");
      const link = join(directory, "symlink.eml");
      await symlink(output, link);
      expect((await download(link)).code).toBe(1);
      expect(await readFile(output, "utf8")).toBe("keep this file");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("does not retry failed writes automatically", async () => {
    let calls = 0;
    const source = Bun.serve({
      port: 0,
      fetch: () => {
        calls++;
        return Response.json({ error: "outage" }, { status: 503 });
      },
    });
    servers.push(source);
    const client = new MailClient({ url: source.url.href, token: "secret" });
    await expect(client.call("POST", "/v1/inboxes", {})).rejects.toThrow("HTTP 503");
    expect(calls).toBe(1);
  });

  test("MCP exposes tools and sends with the caller's stable idempotency key", async () => {
    const received: {
      path: string;
      authorization: string | null;
      key: string | null;
      body: unknown;
    }[] = [];
    const source = Bun.serve({
      port: 0,
      fetch: async (request) => {
        received.push({
          path: new URL(request.url).pathname,
          authorization: request.headers.get("authorization"),
          key: request.headers.get("idempotency-key"),
          body: await request.json(),
        });
        return Response.json({ id: "send-id", status: "pending" }, { status: 202 });
      },
    });
    servers.push(source);
    const server = createMcpHandler(() =>
      createMailServer(new MailClient({ url: source.url.href, token: "inbox-secret" })),
    );
    const client = new Client(
      { name: "test-agent", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      fetch: (url, init) => server.fetch(new Request(url, init)),
    });
    await client.connect(transport);
    try {
      expect(client.getProtocolEra()).toBe("modern");
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain("create_inbox");
      expect(tools.tools.map((tool) => tool.name)).toContain("get_send_status");
      const inboxId = "ce2a9661-bef3-4d2c-9eb8-cd7bacb79720";
      const result = await client.callTool({
        name: "send_email",
        arguments: {
          inbox_id: inboxId,
          to: ["recipient@example.net"],
          subject: "Hello",
          text: "Body",
          idempotency_key: "task-123-message-1",
        },
      });
      expect(result.isError).not.toBe(true);
      expect(result.content).toEqual([
        { type: "text", text: '{"id":"send-id","status":"pending"}' },
      ]);
      expect(received).toEqual([
        {
          path: `/v1/inboxes/${inboxId}/send`,
          authorization: "Bearer inbox-secret",
          key: "task-123-message-1",
          body: { text: "Body", to: ["recipient@example.net"], subject: "Hello" },
        },
      ]);
      await client.callTool({
        name: "send_email",
        arguments: {
          inbox_id: inboxId,
          to: ["recipient@example.net"],
          subject: "Hello",
          text: "Body",
          idempotency_key: "task-123-message-1",
        },
      });
      expect(received[1].key).toBe(received[0].key);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
