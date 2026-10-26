import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { MailClient } from "../src/client";
import { executeCli, parseCliArgs } from "../src/cli-commands";
import { createMailServer } from "../src/mcp-server";

const inbox = "ce2a9661-bef3-4d2c-9eb8-cd7bacb79720";
const notes = "Registered for receipts.\n日本語のメモ";
const urls = ["https://shop.example/account", "https://help.example/"];
function fixture() {
  const calls: { url: string; method: string | undefined; body: unknown }[] = [];
  const mail = new MailClient({
    url: "https://api.example.org",
    token: "synthetic-admin",
    fetch: async (url, init) => {
      calls.push({
        url: String(url),
        method: init.method,
        body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
      });
      return Response.json({ ok: true });
    },
  });
  return { mail, calls };
}

test("CLI creates and edits metadata, preserving omissions and distinguishing site URLs from the API URL", async () => {
  const { mail, calls } = fixture();
  await executeCli(
    mail,
    parseCliArgs([
      "inbox",
      "create",
      "--label",
      "shop",
      "--notes",
      notes,
      "--site-url",
      urls[0]!,
      "--site-url",
      urls[1]!,
    ]),
  );
  await executeCli(mail, parseCliArgs(["inbox", "edit", inbox, "--notes", ""]));
  await executeCli(mail, parseCliArgs(["inbox", "edit", inbox, "--clear-urls"]));
  await executeCli(mail, parseCliArgs(["inbox", "edit", inbox, "--label", ""]));
  expect(calls).toEqual([
    {
      url: "https://api.example.org/v1/inboxes",
      method: "POST",
      body: { label: "shop", notes, urls },
    },
    {
      url: `https://api.example.org/v1/inboxes/${inbox}/metadata`,
      method: "PATCH",
      body: { notes: "" },
    },
    {
      url: `https://api.example.org/v1/inboxes/${inbox}/metadata`,
      method: "PATCH",
      body: { urls: [] },
    },
    {
      url: `https://api.example.org/v1/inboxes/${inbox}/metadata`,
      method: "PATCH",
      body: { label: "" },
    },
  ]);
});

test("CLI reads bounded notes files and rejects malformed or conflicting metadata without a request", async () => {
  const { mail, calls } = fixture();
  const directory = await mkdtemp(join(tmpdir(), "agentpost-inbox-notes-"));
  const file = join(directory, "notes.md"),
    large = join(directory, "large.md"),
    invalid = join(directory, "invalid.md");
  try {
    await writeFile(file, notes);
    await writeFile(large, "a".repeat(40_001));
    await writeFile(invalid, new Uint8Array([0xff]));
    await executeCli(mail, parseCliArgs(["inbox", "edit", inbox, "--notes-file", file]));
    expect(calls[0]?.body).toEqual({ notes });
    calls.length = 0;
    for (const args of [
      ["edit", inbox],
      ["edit", inbox, "--local-part", "rename"],
      ["edit", inbox, "--site-url", "bad"],
      ["edit", inbox, "--site-url", "https://u:p@site.example"],
      ["edit", inbox, "--clear-urls", "--site-url", urls[0]!],
      ["create", "--notes", notes, "--notes-file", file],
      ["create", "--notes", "a".repeat(10_001)],
      ["edit", inbox, "--notes-file", large],
      ["edit", inbox, "--notes-file", invalid],
    ])
      await expect(executeCli(mail, parseCliArgs(["inbox", ...args]))).rejects.toThrow();
    expect(calls).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("real CLI --url selects only the API and --site-url remains optional stored metadata", async () => {
  const calls: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      calls.push(await request.json());
      return Response.json({ notes, urls });
    },
  });
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        "run",
        "src/cli.ts",
        "inbox",
        "create",
        "--url",
        server.url.href,
        "--notes",
        notes,
        "--site-url",
        urls[0]!,
        "--site-url",
        urls[1]!,
      ],
      {
        env: {
          ...process.env,
          AGENTPOST_API_URL: "https://must-not-contact.invalid",
          AGENTPOST_API_TOKEN: "synthetic-admin",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const output = new Response(child.stdout).text(),
      error = new Response(child.stderr).text();
    expect(await child.exited).toBe(0);
    expect(await error).toBe("");
    expect(JSON.parse(await output)).toEqual({ notes, urls });
    expect(calls).toEqual([{ label: "", notes, urls }]);
  } finally {
    server.stop(true);
  }
});

test("MCP advertises optional creation fields and applies nonempty field-preserving metadata edits", async () => {
  const { mail, calls } = fixture();
  const handler = createMcpHandler(() => createMailServer(mail));
  const mcp = new Client(
    { name: "inbox-metadata-test", version: "1" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  try {
    await mcp.connect(
      new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
        fetch: (url, init) => handler.fetch(new Request(url, init)),
      }),
    );
    const catalog = await mcp.listTools();
    const create = catalog.tools.find((tool) => tool.name === "create_inbox");
    expect(create?.inputSchema.properties).toHaveProperty("notes");
    expect(create?.inputSchema.properties).toHaveProperty("urls");
    const edit = catalog.tools.find((tool) => tool.name === "update_inbox");
    expect(edit?.annotations).toMatchObject({
      idempotentHint: true,
      destructiveHint: true,
      openWorldHint: false,
    });
    expect(
      (await mcp.callTool({ name: "create_inbox", arguments: { notes, urls } })).isError,
    ).not.toBe(true);
    expect(
      (await mcp.callTool({ name: "update_inbox", arguments: { inbox_id: inbox, notes: "" } }))
        .isError,
    ).not.toBe(true);
    expect(
      (await mcp.callTool({ name: "update_inbox", arguments: { inbox_id: inbox, urls: [] } }))
        .isError,
    ).not.toBe(true);
    expect(calls.map((call) => call.body)).toEqual([
      { label: "", notes, urls },
      { notes: "" },
      { urls: [] },
    ]);
    calls.length = 0;
    for (const input of [
      { inbox_id: inbox },
      { inbox_id: inbox, active: false },
      { inbox_id: inbox, urls: ["file:///tmp/private"] },
    ]) {
      try {
        expect((await mcp.callTool({ name: "update_inbox", arguments: input })).isError).toBe(true);
      } catch (error) {
        expect(String(error)).toMatch(/Invalid|input|parameter|argument/i);
      }
    }
    expect(calls).toEqual([]);
  } finally {
    await mcp.close();
    await handler.close();
  }
});
