import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { z } from "zod";
import { version } from "../package.json";
import { executableName } from "./executable-targets";

const nodeMode = process.argv[2] === "--node";
const prefix = nodeMode ? [resolve(process.argv[3]!)] : [];
const executable = nodeMode
  ? Bun.which("node")!
  : process.argv[2] === "--platform"
    ? resolve("dist", "executables", executableName(version, process.argv[3]!))
    : resolve(process.argv[2] ?? "");
const directory = await mkdtemp(join(tmpdir(), "agentpost-standalone-"));
const inbox = "11111111-1111-4111-8111-111111111111";
const token = "standalone-fixture-token-not-a-real-credential";
const messages = { messages: [], next_cursor: null };
let requests = 0;
const api = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    assert.equal(request.headers.get("Authorization"), `Bearer ${token}`);
    assert.equal(request.method, "GET");
    assert.equal(new URL(request.url).pathname, `/v1/inboxes/${inbox}/messages`);
    requests++;
    return Response.json(messages);
  },
});
// The executable runs without source, node_modules, or Bun on its PATH.
const environment: NodeJS.ProcessEnv = { ...process.env, PATH: directory };
delete environment.AGENTPOST_API_URL;
delete environment.AGENTPOST_API_TOKEN;
delete environment.BUN_OPTIONS;
delete environment.NODE_OPTIONS;

async function cli(args: string[], configured = false) {
  const child = Bun.spawn([executable, ...prefix, ...args], {
    cwd: directory,
    env: {
      ...environment,
      ...(configured ? { AGENTPOST_API_URL: api.url.href, AGENTPOST_API_TOKEN: token } : {}),
    },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 15_000,
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

async function mcp() {
  const client = new Client(
    { name: "standalone-smoke", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  const transport = new StdioClientTransport({
    command: executable,
    args: [...prefix, "mcp"],
    cwd: directory,
    env: { ...environment, AGENTPOST_API_URL: api.url.href, AGENTPOST_API_TOKEN: token },
    stderr: "pipe",
  });
  try {
    await client.connect(transport, { timeout: 10_000 });
    assert.equal(client.getServerVersion()?.version, version);
    const tools = await client.listTools();
    assert(tools.tools.some((tool) => tool.name === "list_messages"));
    const result = await client.callTool({
      name: "list_messages",
      arguments: { inbox_id: inbox, limit: 1 },
    });
    assert.deepEqual(result.structuredContent, messages);
    const events = await client.request(
      { method: "events/list", params: {} },
      z.object({ events: z.array(z.object({ name: z.string() })) }),
    );
    assert(events.events.some((event) => event.name === "message.received"));
  } finally {
    await client.close();
  }
}

try {
  await writeFile(
    join(directory, ".env"),
    `AGENTPOST_API_URL=${api.url.href}\nAGENTPOST_API_TOKEN=${token}\n`,
  );
  await writeFile(join(directory, "bunfig.toml"), 'preload = ["./poison.ts"]\n');
  await writeFile(join(directory, "poison.ts"), 'throw new Error("Unexpected runtime preload");\n');
  assert.deepEqual(await cli(["--version"]), {
    code: 0,
    stdout: `agentpost ${version}\n`,
    stderr: "",
  });
  const help = await cli(["--help"]);
  assert.equal(help.code, 0);
  assert(help.stdout.includes("agentpost"));
  assert.equal((await cli(["health"])).code, 1);
  assert.equal(requests, 0);
  const listed = await cli(["message", "list", inbox], true);
  assert.equal(listed.code, 0);
  assert.deepEqual(JSON.parse(listed.stdout), messages);
  await mcp();
  assert.equal(requests, 2);
  console.log("Standalone CLI, MCP, Events, and runtime configuration isolation passed");
} finally {
  await api.stop(true);
  await rm(directory, { recursive: true, force: true });
}
