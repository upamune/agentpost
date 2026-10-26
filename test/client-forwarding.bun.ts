import { expect, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { MailClient } from "../src/client";
import { executeCli, parseCliArgs } from "../src/cli-commands";
import { createMailServer } from "../src/mcp-server";

const inbox = "ce2a9661-bef3-4d2c-9eb8-cd7bacb79720";
const message = "a".repeat(64),
  destination = "owner@example.net";
const base = `/v1/inboxes/${inbox}/forwarding`;
function fixture() {
  const calls: { path: string; method: string | undefined; body: unknown }[] = [];
  const client = new MailClient({
    url: "https://api.example.org",
    token: "synthetic-admin",
    fetch: async (url, init) => {
      expect(new Headers(init.headers).get("Authorization")).toBe("Bearer synthetic-admin");
      calls.push({
        path: url.pathname,
        method: init.method,
        body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
      });
      return Response.json({ ok: true });
    },
  });
  return { client, calls };
}
const commands = [
  { args: ["get"], method: "GET", path: "/v1/forwarding", body: undefined },
  {
    args: ["set", "--destination", destination],
    method: "PUT",
    path: "/v1/forwarding",
    body: { destination },
  },
  { args: ["off"], method: "PUT", path: "/v1/forwarding", body: { destination: null } },
  { args: ["get", inbox], method: "GET", path: base, body: undefined },
  {
    args: ["set", inbox, "--destination", destination],
    method: "PUT",
    path: base,
    body: { mode: "custom", destination },
  },
  { args: ["off", inbox], method: "PUT", path: base, body: { mode: "off" } },
  { args: ["inherit", inbox], method: "PUT", path: base, body: { mode: "inherit" } },
  { args: ["deliveries", inbox], method: "GET", path: `${base}/deliveries`, body: undefined },
  {
    args: ["resolve", inbox, message, "--note", "Provider checked"],
    method: "POST",
    path: `${base}/deliveries/${message}/resolve`,
    body: { note: "Provider checked" },
  },
];
test("CLI distinguishes global defaults, inbox overrides, history and acknowledgment", async () => {
  const { client, calls } = fixture();
  for (const command of commands) {
    await executeCli(client, parseCliArgs(["forwarding", ...command.args]));
    expect(calls.at(-1)).toEqual({
      path: command.path,
      method: command.method,
      body: command.body,
    });
  }
});
test("invalid forwarding commands fail before network access", async () => {
  const { client, calls } = fixture();
  for (const args of [
    ["set"],
    ["set", "--destination", "bad"],
    ["get", "not-a-uuid"],
    ["inherit"],
    ["deliveries"],
    ["resolve", inbox, "bad", "--note", "checked"],
  ])
    await expect(executeCli(client, parseCliArgs(["forwarding", ...args]))).rejects.toThrow();
  expect(calls).toEqual([]);
});
test("MCP forwarding tools preserve administrative contracts and safety hints", async () => {
  const { client: mail, calls } = fixture();
  const handler = createMcpHandler(() => createMailServer(mail));

  const mcp = new Client(
    { name: "forwarding-test", version: "1" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  try {
    await mcp.connect(
      new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
        fetch: (url, init) => handler.fetch(new Request(url, init)),
      }),
    );
    const catalog = await mcp.listTools();
    for (const name of [
      "get_global_forwarding",
      "get_inbox_forwarding",
      "list_forwarding_deliveries",
    ])
      expect(catalog.tools.find((tool) => tool.name === name)?.annotations?.readOnlyHint).toBe(
        true,
      );
    for (const name of ["set_global_forwarding", "set_inbox_forwarding"])
      expect(catalog.tools.find((tool) => tool.name === name)?.annotations).toMatchObject({
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      });
    await mcp.callTool({ name: "set_global_forwarding", arguments: { destination } });
    await mcp.callTool({
      name: "set_inbox_forwarding",
      arguments: { inbox_id: inbox, configuration: { mode: "off" } },
    });
    await mcp.callTool({
      name: "set_inbox_forwarding",
      arguments: { inbox_id: inbox, configuration: { mode: "inherit" } },
    });
    await mcp.callTool({ name: "list_forwarding_deliveries", arguments: { inbox_id: inbox } });
    await mcp.callTool({
      name: "resolve_forwarding",
      arguments: { inbox_id: inbox, message_id: message, note: "Provider checked" },
    });
    expect(calls).toEqual([
      { path: "/v1/forwarding", method: "PUT", body: { destination } },
      { path: base, method: "PUT", body: { mode: "off" } },
      { path: base, method: "PUT", body: { mode: "inherit" } },
      { path: `${base}/deliveries`, method: "GET", body: undefined },
      {
        path: `${base}/deliveries/${message}/resolve`,
        method: "POST",
        body: { note: "Provider checked" },
      },
    ]);
  } finally {
    await mcp.close();
    await handler.close();
  }
});
