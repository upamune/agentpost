import { expect, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { MailClient } from "../src/client";
import { executeCli, parseCliArgs } from "../src/cli-commands";
import { MailSendError, resolveIdempotencyKey } from "../src/idempotency";
import { createMailServer } from "../src/mcp-server";
import { z } from "zod";

const inbox = "ce2a9661-bef3-4d2c-9eb8-cd7bacb79720";
const path = `/v1/inboxes/${inbox}/send`;
const body = { to: ["recipient@example.net"], subject: "Report", text: "Hello" };
const uuidV4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

test("only an omitted key generates UUIDv4; explicit keys remain exact and invalid keys reject", () => {
  const keys = new Set(Array.from({ length: 100 }, () => resolveIdempotencyKey(undefined)));
  expect(keys.size).toBe(100);
  for (const key of keys) expect(key).toMatch(uuidV4);
  expect(resolveIdempotencyKey("Report.v1:_-")).toBe("Report.v1:_-");
  for (const key of ["", " ", "a b", "\r\n", "雪", "x".repeat(129)])
    expect(() => resolveIdempotencyKey(key)).toThrow("Idempotency key");
});

test("a lost send response exposes its pre-network key without retrying and reuse recovers the send", async () => {
  const saved = new Map<string, string>();
  const requests: string[] = [];
  let loseResponse = true;
  const client = new MailClient({
    url: "https://mail.example.com",
    token: "private-bearer",
    fetch: async (_url, init) => {
      const key = new Headers(init.headers).get("Idempotency-Key")!;
      requests.push(key);
      const serialized = String(init.body);
      if (saved.has(key) && saved.get(key) !== serialized)
        return new Response("hostile private-bearer", { status: 409 });
      saved.set(key, serialized);
      if (loseResponse) {
        loseResponse = false;
        throw new Error("Request lost: private-bearer");
      }
      return Response.json({ id: "durable-send", status: "accepted", idempotency_key: key });
    },
  });
  let failure: unknown;
  try {
    await client.callSend(path, body);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(MailSendError);
  const key = (failure as MailSendError).idempotencyKey;
  expect(key).toMatch(uuidV4);
  expect(String(failure)).toContain(key);
  expect(String(failure)).not.toContain("private-bearer");
  expect(requests).toEqual([key]);
  expect(await client.callSend(path, body, key)).toEqual({
    id: "durable-send",
    status: "accepted",
    idempotency_key: key,
  });
  expect(saved.size).toBe(1);
  await expect(client.callSend(path, { ...body, text: "Changed" }, key)).rejects.toMatchObject({
    status: 409,
    idempotencyKey: key,
  });
  expect(requests).toEqual([key, key, key]);
  expect(saved.size).toBe(1);
  await client.callSend(path, body);
  expect(saved.size).toBe(2);
});

test("explicit invalid send keys fail before network and explicit empty low-level headers are preserved", async () => {
  const headers: string[] = [];
  const client = new MailClient({
    url: "https://mail.example.com",
    token: "secret",
    fetch: async (_url, init) => {
      headers.push(new Headers(init.headers).get("Idempotency-Key")!);
      return Response.json({ ok: true });
    },
  });
  for (const key of ["", "bad key", "x".repeat(129)])
    await expect(client.callSend(path, body, key)).rejects.toThrow("Idempotency key");
  expect(headers).toEqual([]);
  await client.call("POST", path, body, "");
  expect(headers).toEqual([""]);
});

test("HTTP failure preserves the generated key and rate-limit retry metadata without retry", async () => {
  let calls = 0;
  const client = new MailClient({
    url: "https://mail.example.com",
    token: "secret",
    fetch: async () => {
      calls++;
      return new Response("secret", { status: 429, headers: { "Retry-After": "60" } });
    },
  });
  await expect(client.callSend(path, body, "stable-key")).rejects.toMatchObject({
    status: 429,
    retryAfterMs: 60_000,
    idempotencyKey: "stable-key",
  });
  expect(calls).toBe(1);
});

test("send failures retain keys across serialization, JSON, and mismatched-response errors", async () => {
  const replies = [
    new Response("hostile private-bearer", { headers: { "Content-Type": "application/json" } }),
    Response.json({ idempotency_key: "unexpected-key" }),
  ];
  let calls = 0;
  const client = new MailClient({
    url: "https://mail.example.com",
    token: "private-bearer",
    fetch: async () => {
      calls++;
      return replies.shift()!;
    },
  });
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  await expect(client.callSend(path, circular, "serialize-key")).rejects.toMatchObject({
    idempotencyKey: "serialize-key",
  });
  expect(calls).toBe(0);
  for (const key of ["json-key", "response-key"]) {
    try {
      await client.callSend(path, body, key);
      throw new Error("Expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(MailSendError);
      expect((error as MailSendError).idempotencyKey).toBe(key);
      expect(String(error)).not.toContain("private-bearer");
    }
  }
  expect(calls).toBe(2);
});

test("CLI returns a recovery key even when attachment preparation fails before sending", async () => {
  let calls = 0;
  const client = new MailClient({
    url: "https://mail.example.com",
    token: "secret",
    fetch: async () => {
      calls++;
      return Response.json({});
    },
  });
  const args = parseCliArgs([
    "send",
    inbox,
    "--to",
    body.to[0]!,
    "--subject",
    body.subject,
    "--text",
    body.text,
    "--attach",
    "/nonexistent/agentpost-test-missing.pdf",
  ]);
  let failure: unknown;
  try {
    await executeCli(client, args);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(MailSendError);
  expect((failure as MailSendError).idempotencyKey).toMatch(uuidV4);
  expect(String(failure)).toContain("Save this key");
  expect(calls).toBe(0);
});

test("MCP generates keys for send/reply and exposes the same key on a lost response", async () => {
  const requests: { path: string; key: string }[] = [];
  let fail = true;
  const handler = createMcpHandler(() =>
    createMailServer(
      new MailClient({
        url: "https://mail.example.com",
        token: "private-bearer",
        fetch: async (url, init) => {
          const key = new Headers(init.headers).get("Idempotency-Key")!;
          requests.push({ path: url.pathname, key });
          if (fail) {
            fail = false;
            throw new Error("private-bearer");
          }
          return Response.json({ id: "send", status: "pending", idempotency_key: key });
        },
      }),
    ),
  );
  const client = new Client(
    { name: "idempotency-test", version: "1" },
    {
      versionNegotiation: { mode: { pin: "2026-07-28" } },
    },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
    }),
  );
  try {
    const tools = await client.listTools();
    for (const name of ["send_email", "reply_email"]) {
      const tool = tools.tools.find((entry) => entry.name === name)!;
      expect(tool.annotations?.idempotentHint).toBe(false);
      expect(tool.inputSchema.required).not.toContain("idempotency_key");
    }
    const args = { inbox_id: inbox, ...body };
    const failed = await client.callTool({ name: "send_email", arguments: args });
    expect(failed.isError).toBe(true);
    const key = z
      .object({ idempotency_key: z.string() })
      .parse(failed.structuredContent).idempotency_key;
    expect(key).toMatch(uuidV4);
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(failed)).not.toContain("private-bearer");
    const recovered = await client.callTool({
      name: "send_email",
      arguments: { ...args, idempotency_key: key },
    });
    expect(recovered.isError).not.toBe(true);
    expect(recovered.structuredContent).toMatchObject({ idempotency_key: key });
    expect(requests[1]?.key).toBe(key as string);
    const reply = await client.callTool({
      name: "reply_email",
      arguments: {
        inbox_id: inbox,
        message_id: "a".repeat(64),
        text: "Reply",
      },
    });
    expect(
      z.object({ idempotency_key: z.string() }).parse(reply.structuredContent).idempotency_key,
    ).toMatch(uuidV4);
    expect(requests[2]?.path).toContain("/reply");
    expect(requests[2]?.key).not.toBe(key as string);
    const invalid = await client.callTool({
      name: "send_email",
      arguments: {
        ...args,
        idempotency_key: "",
      },
    });
    expect(invalid.isError).toBe(true);
    expect(requests).toHaveLength(3);
  } finally {
    await client.close();
    await handler.close();
  }
});
