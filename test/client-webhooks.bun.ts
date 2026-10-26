import { afterEach, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";
import { MailClient } from "../src/client";
import { executeCli, parseCliArgs } from "../src/cli-commands";
import { createMailServer } from "../src/mcp-server";
import { webhookSignature } from "../src/webhook-crypto";

const inbox = "ce2a9661-bef3-4d2c-9eb8-cd7bacb79720";
const foreign = "1155831b-df32-459f-b5fa-464e9a8f00ee";
const token = "synthetic-inbox-bearer";
const secret = "whsec_synthetic-signing-secret";
const receiver = "https://receiver.example.org/mail?opaque=synthetic";
const path = `/v1/inboxes/${inbox}/webhook`;
const servers: ReturnType<typeof Bun.serve>[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
});

test("Standard Webhooks signature matches an independent fixed-byte HMAC vector", async () => {
  const key = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
  const signingSecret = `whsec_${key.toString("base64")}`;
  const id = "msg_fixed";
  const timestamp = "1700000000";
  const body = '{"type":"message.received","data":{"note":"雪🦊"}}\n';
  const expected = createHmac("sha256", key)
    .update(`${id}.${timestamp}.${body}`, "utf8")
    .digest("base64");
  // This literal also independently matches Python hmac/hashlib for these exact bytes.
  expect(expected).toBe("PBR+UzshZvczhBuTkTiVtAjzdgCSnIJEMAPZ6nhSSpg=");
  expect(await webhookSignature(signingSecret, id, timestamp, body)).toBe(`v1,${expected}`);
  for (const [changedId, changedTime, changedBody] of [
    ["other-id", timestamp, body],
    [id, "1700000001", body],
    [id, timestamp, body.trimEnd()],
    [id, timestamp, JSON.stringify(JSON.parse(body), null, 2)],
  ]) {
    expect(await webhookSignature(signingSecret, changedId!, changedTime!, changedBody!)).not.toBe(
      `v1,${expected}`,
    );
  }
});

interface Captured {
  url: string;
  method: string | undefined;
  authorization: string | null;
  redirect: RequestInit["redirect"];
  body: unknown;
}

function fixture() {
  const requests: Captured[] = [];
  let configured = false;
  const client = new MailClient({
    url: "https://api.example.org",
    token,
    fetch: async (url, init) => {
      requests.push({
        url: url.href,
        method: init.method,
        authorization: new Headers(init.headers).get("Authorization"),
        redirect: init.redirect,
        body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
      });
      if (url.pathname.includes(foreign))
        return new Response(`private ${token} ${secret}`, { status: 404 });
      if (url.pathname.endsWith("/deliveries")) return Response.json({ deliveries: [] });
      if (init.method === "PUT") {
        configured = true;
        return Response.json({ inbox_id: inbox, enabled: true, url: receiver, secret });
      }
      if (init.method === "DELETE") configured = false;
      return Response.json({ inbox_id: inbox, enabled: configured });
    },
  });
  return { client, requests };
}

test("CLI webhook contracts keep inbox scope, secret-once responses and protected API routing", async () => {
  const { client, requests } = fixture();
  expect(
    await executeCli(client, parseCliArgs(["webhook", "set", inbox, "--webhook-url", receiver])),
  ).toEqual({ result: { inbox_id: inbox, enabled: true, url: receiver, secret } });
  for (const action of ["get", "deliveries", "delete"]) {
    const output = await executeCli(client, parseCliArgs(["webhook", action, inbox]));
    expect(JSON.stringify(output)).not.toContain(secret);
    expect(JSON.stringify(output)).not.toContain(token);
  }
  expect(requests).toEqual([
    {
      url: `https://api.example.org${path}`,
      method: "PUT",
      body: { url: receiver },
      authorization: `Bearer ${token}`,
      redirect: "manual",
    },
    {
      url: `https://api.example.org${path}`,
      method: "GET",
      body: undefined,
      authorization: `Bearer ${token}`,
      redirect: "manual",
    },
    {
      url: `https://api.example.org${path}/deliveries`,
      method: "GET",
      body: undefined,
      authorization: `Bearer ${token}`,
      redirect: "manual",
    },
    {
      url: `https://api.example.org${path}`,
      method: "DELETE",
      body: undefined,
      authorization: `Bearer ${token}`,
      redirect: "manual",
    },
  ]);
});

test("CLI rejects missing webhook URL and invalid inbox locally; API ownership errors remain sanitized", async () => {
  const { client, requests } = fixture();
  for (const args of [
    ["webhook", "set", inbox],
    ["webhook", "set", inbox, "--url", receiver],
    ["webhook", "get", "../other/inbox"],
    ["webhook", "unknown", inbox],
  ]) {
    await expect(executeCli(client, parseCliArgs(args))).rejects.toThrow();
  }
  expect(requests).toHaveLength(0);
  for (const action of ["get", "set", "delete", "deliveries"]) {
    const args = ["webhook", action, foreign, "--webhook-url", receiver];
    try {
      await executeCli(client, parseCliArgs(args));
      throw new Error("Expected API rejection");
    } catch (error) {
      expect(String(error)).toContain("HTTP 404");
      expect(String(error)).not.toContain(token);
      expect(String(error)).not.toContain(secret);
    }
  }
  expect(requests).toHaveLength(4);
  expect(requests.every((entry) => entry.url.includes(foreign))).toBe(true);
});

test("CLI --url selects only Agentpost API; --webhook-url remains the JSON receiver URL", async () => {
  let defaultCalls = 0;
  const ignored = Bun.serve({
    port: 0,
    fetch: () => {
      defaultCalls++;
      return new Response("Wrong API", { status: 500 });
    },
  });
  servers.push(ignored);
  const received: { url: string; authorization: string | null; body: unknown }[] = [];
  const selected = Bun.serve({
    port: 0,
    fetch: async (request) => {
      received.push({
        url: request.url,
        authorization: request.headers.get("Authorization"),
        body: await request.json(),
      });
      return Response.json({ inbox_id: inbox, enabled: true, secret });
    },
  });
  servers.push(selected);
  const child = Bun.spawn(
    [
      process.execPath,
      "run",
      "src/cli.ts",
      "webhook",
      "set",
      inbox,
      "--url",
      selected.url.href,
      "--webhook-url",
      receiver,
    ],
    {
      env: { ...process.env, AGENTPOST_API_URL: ignored.url.href, AGENTPOST_API_TOKEN: token },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(await child.exited).toBe(0);
  expect(JSON.parse(await new Response(child.stdout).text())).toHaveProperty("secret", secret);
  expect(await new Response(child.stderr).text()).toBe("");
  expect(defaultCalls).toBe(0);
  expect(received).toEqual([
    {
      url: new URL(path, selected.url).href,
      authorization: `Bearer ${token}`,
      body: { url: receiver },
    },
  ]);
});

async function mcpFixture(mailClient: MailClient) {
  const server = createMcpHandler(() => createMailServer(mailClient));
  const client = new Client(
    { name: "webhook-test", version: "1" },
    {
      versionNegotiation: { mode: { pin: "2026-07-28" } },
    },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      fetch: (url, init) => server.fetch(new Request(url, init)),
    }),
  );
  return { client, server };
}

test("MCP webhook tools advertise safe hints and preserve all four HTTP contracts", async () => {
  const { client: api, requests } = fixture();
  const { client, server } = await mcpFixture(api);
  try {
    const tools = (await client.listTools()).tools;
    expect(tools.find((tool) => tool.name === "get_webhook")?.annotations?.readOnlyHint).toBe(true);
    expect(
      tools.find((tool) => tool.name === "list_webhook_deliveries")?.annotations?.readOnlyHint,
    ).toBe(true);
    expect(tools.find((tool) => tool.name === "set_webhook")?.annotations?.idempotentHint).toBe(
      false,
    );
    const configured = await client.callTool({
      name: "set_webhook",
      arguments: { inbox_id: inbox, url: receiver },
    });
    expect(configured.isError).not.toBe(true);
    expect(configured.structuredContent).toMatchObject({ secret, url: receiver });
    for (const name of ["get_webhook", "list_webhook_deliveries", "delete_webhook"]) {
      const output = await client.callTool({ name, arguments: { inbox_id: inbox } });
      expect(output.isError).not.toBe(true);
      expect(JSON.stringify(output)).not.toContain(secret);
      expect(JSON.stringify(output)).not.toContain(token);
    }
    expect(
      requests.map((request) => [request.method, new URL(request.url).pathname, request.body]),
    ).toEqual([
      ["PUT", path, { url: receiver }],
      ["GET", path, undefined],
      ["GET", `${path}/deliveries`, undefined],
      ["DELETE", path, undefined],
    ]);
    expect(requests.every((entry) => entry.authorization === `Bearer ${token}`)).toBe(true);
    expect(requests.every((entry) => new URL(entry.url).origin === "https://api.example.org")).toBe(
      true,
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP rejects invalid inputs locally and returns sanitized ownership errors without retry", async () => {
  const { client: api, requests } = fixture();
  const { client, server } = await mcpFixture(api);
  try {
    for (const args of [
      { inbox_id: "invalid" },
      { inbox_id: inbox, url: "not-a-url" },
      { inbox_id: inbox, url: receiver, secret: "injected" },
    ]) {
      expect((await client.callTool({ name: "set_webhook", arguments: args })).isError).toBe(true);
    }
    expect(requests).toHaveLength(0);
    for (const name of [
      "get_webhook",
      "set_webhook",
      "delete_webhook",
      "list_webhook_deliveries",
    ]) {
      const args =
        name === "set_webhook" ? { inbox_id: foreign, url: receiver } : { inbox_id: foreign };
      const output = await client.callTool({ name, arguments: args });
      expect(output.isError).toBe(true);
      expect(JSON.stringify(output)).toContain("HTTP 404");
      expect(JSON.stringify(output)).not.toContain(token);
      expect(JSON.stringify(output)).not.toContain(secret);
    }
    expect(requests).toHaveLength(4);
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP webhook replacement timeout is never automatically retried", async () => {
  let calls = 0;
  const api = new MailClient({
    url: "https://api.example.org",
    token,
    fetch: async () => {
      calls++;
      throw new Error(`Simulated timeout ${token} ${secret}`);
    },
  });
  const { client, server } = await mcpFixture(api);
  try {
    const output = await client.callTool({
      name: "set_webhook",
      arguments: { inbox_id: inbox, url: receiver },
    });
    expect(output.isError).toBe(true);
    expect(calls).toBe(1);
    expect(JSON.stringify(output)).not.toContain(token);
    expect(JSON.stringify(output)).not.toContain(secret);
    expect(z.object({ isError: z.literal(true) }).parse(output)).toEqual({ isError: true });
  } finally {
    await client.close();
    await server.close();
  }
});
