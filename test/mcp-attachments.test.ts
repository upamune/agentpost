import { applyD1Migrations, createExecutionContext, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { beforeEach, expect, test } from "vitest";
import { z } from "zod";
import worker from "../src/index";
import { MAX_ATTACHMENT_BYTES, MAX_MCP_REQUEST_BYTES } from "../src/attachment-policy";
import { sha256 } from "../src/common";
import type { Env } from "../src/types";

const bindings: Env = env;
const admin = "test-admin-token-with-at-least-32-characters";
const uploaded = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number(),
  sha256: z.string(),
  scan_status: z.literal("not_scanned"),
  reused: z.boolean(),
});

beforeEach(async () => {
  await reset();
  await applyD1Migrations(bindings.DB, env.TEST_MIGRATIONS);
});

async function inbox() {
  const response = await worker.fetch(
    new Request("https://mail.test/v1/inboxes", {
      method: "POST",
      headers: { Authorization: `Bearer ${admin}`, "Content-Type": "application/json" },
      body: "{}",
    }),
    bindings,
    createExecutionContext(),
  );
  expect(response.status).toBe(201);
  return z.object({ id: z.uuid(), token: z.string() }).parse(await response.json());
}

async function mcp(token: string) {
  const client = new Client(
    { name: "remote-attachment-test", version: "1" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL("https://mail.test/mcp"), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
      fetch: (input, init) =>
        worker.fetch(new Request(input, init), bindings, createExecutionContext()),
    }),
  );
  return client;
}

test("remote MCP stores a maximum-size Base64 upload in real R2 without bypassing the combined send limit", async () => {
  const box = await inbox();
  const client = await mcp(box.token);
  try {
    const tools = await client.listTools();
    expect(tools.tools.find((tool) => tool.name === "upload_attachment")).toBeDefined();
    const content = "a".repeat(MAX_ATTACHMENT_BYTES);
    const input = { inbox_id: box.id, filename: "report.txt", content_base64: btoa(content) };
    const result = await client.callTool({ name: "upload_attachment", arguments: input });
    expect(result.isError).not.toBe(true);
    const file = uploaded.parse(result.structuredContent);
    expect(file).toMatchObject({
      size: MAX_ATTACHMENT_BYTES,
      sha256: await sha256(content),
      reused: false,
    });
    const object = await bindings.MAIL.get(`outbound-attachments/${box.id}/${file.id}`);
    expect(object?.size).toBe(MAX_ATTACHMENT_BYTES);
    expect(await object?.text()).toBe(content);
    const again = await client.callTool({ name: "upload_attachment", arguments: input });
    expect(uploaded.parse(again.structuredContent)).toMatchObject({ id: file.id, reused: true });
    expect((await bindings.MAIL.list({ prefix: "outbound-attachments/" })).objects).toHaveLength(1);
    const overBudget = await client.callTool({
      name: "send_email",
      arguments: {
        inbox_id: box.id,
        to: ["recipient@example.net"],
        subject: "Report",
        text: "Attached.",
        attachments: [file.id],
        idempotency_key: "maximum-upload",
      },
    });
    expect(overBudget.isError).toBe(true);
    expect(await bindings.DB.prepare("SELECT count(*) AS count FROM outbox").first("count")).toBe(
      0,
    );
  } finally {
    await client.close();
  }
}, 20_000);

test("remote MCP uploads and queues the same durable attachment IDs across send retries", async () => {
  const box = await inbox();
  const client = await mcp(box.token);
  try {
    const result = await client.callTool({
      name: "upload_attachment",
      arguments: { inbox_id: box.id, filename: "report.csv", content_base64: btoa("value\n42\n") },
    });
    expect(result.isError).not.toBe(true);
    const file = uploaded.parse(result.structuredContent);
    const send = {
      name: "send_email",
      arguments: {
        inbox_id: box.id,
        to: ["recipient@example.net"],
        subject: "Report",
        text: "Attached.",
        attachments: [file.id],
        idempotency_key: "remote-attachment-send",
      },
    };
    const first = await client.callTool(send);
    expect(first.isError).not.toBe(true);
    const saved = z
      .object({ id: z.string(), status: z.literal("pending") })
      .parse(first.structuredContent);
    const retry = await client.callTool(send);
    expect(retry.isError).not.toBe(true);
    expect(retry.structuredContent).toMatchObject({ id: saved.id, status: "pending" });
    const row = await bindings.DB.prepare("SELECT payload FROM outbox WHERE id = ?")
      .bind(saved.id)
      .first<{ payload: string }>();
    expect(JSON.parse(row!.payload).attachments).toEqual([file.id]);
    expect(row!.payload).not.toContain(btoa("value\n42\n"));
    expect(await bindings.DB.prepare("SELECT count(*) AS count FROM outbox").first("count")).toBe(
      1,
    );
  } finally {
    await client.close();
  }
});

test("remote MCP rejects foreign inbox uploads, invalid formats, noncanonical Base64 and oversized files", async () => {
  const own = await inbox();
  const foreign = await inbox();
  const client = await mcp(own.token);
  try {
    const cases = [
      { inbox_id: foreign.id, filename: "report.txt", content_base64: btoa("Private") },
      { inbox_id: own.id, filename: "report.pdf", content_base64: btoa("Not a PDF") },
      { inbox_id: own.id, filename: "report.svg", content_base64: btoa("<svg/>") },
      { inbox_id: own.id, filename: "report.txt", content_base64: "YQ==\n" },
      { inbox_id: own.id, filename: "report.txt", content_base64: "" },
      {
        inbox_id: own.id,
        filename: "report.txt",
        content_base64: btoa("a".repeat(MAX_ATTACHMENT_BYTES + 1)),
      },
    ];
    for (const input of cases) {
      const result = await client.callTool({ name: "upload_attachment", arguments: input });
      expect(result.isError, input.filename).toBe(true);
    }
    expect((await bindings.MAIL.list({ prefix: "outbound-attachments/" })).objects).toHaveLength(0);
  } finally {
    await client.close();
  }
}, 20_000);

test("remote MCP authenticates before consuming oversized bodies and enforces its outer request bound", async () => {
  let read = false;
  const unauthorized = await worker.fetch(
    new Request("https://mail.test/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            read = true;
            controller.enqueue(new Uint8Array(MAX_MCP_REQUEST_BYTES + 1));
            controller.close();
          },
        },
        { highWaterMark: 0 },
      ),
    }),
    bindings,
    createExecutionContext(),
  );
  expect(unauthorized.status).toBe(401);
  expect(read).toBe(false);
  const oversized = await worker.fetch(
    new Request("https://mail.test/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${admin}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: " ".repeat(MAX_MCP_REQUEST_BYTES + 1),
    }),
    bindings,
    createExecutionContext(),
  );
  expect(oversized.status).toBe(413);
  expect((await bindings.MAIL.list({ prefix: "outbound-attachments/" })).objects).toHaveLength(0);
});
