import assert from "node:assert/strict";
import { z } from "zod";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export async function checkNodeFiles(cli: string, parent: string): Promise<void> {
  const directory = join(parent, "file-fixture");
  await mkdir(directory);
  const inbox = "11111111-1111-4111-8111-111111111111";
  const text = "Unicode 日本語 🦊\n";
  const html = "<p>Unicode 日本語 🦊</p>";
  const checkpoint = join(directory, "cursor.json");
  await writeFile(join(directory, "text.txt"), text);
  await writeFile(join(directory, "html.txt"), html);
  await writeFile(checkpoint, JSON.stringify({ cursor: "saved-cursor" }));
  let polls = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      assert.equal(request.headers.get("Authorization"), "Bearer node-file-fixture-token");
      assert.equal(request.method, "POST");
      const body = z.record(z.string(), z.unknown()).parse(await request.json());
      if (new URL(request.url).pathname === `/v1/inboxes/${inbox}/send`) {
        assert.equal(body.text, text);
        assert.equal(body.html, html);
        return Response.json({ id: "synthetic-send", status: "pending" });
      }
      assert.equal(new URL(request.url).pathname, "/v1/events/poll");
      assert.equal(body.cursor, polls++ === 0 ? "saved-cursor" : "next-cursor");
      return Response.json({
        events: [],
        cursor: "next-cursor",
        truncated: false,
        hasMore: false,
        nextPollMs: 1000,
      });
    },
  });
  const spawn = (args: string[]) =>
    Bun.spawn([Bun.which("node")!, cli, ...args], {
      cwd: directory,
      env: {
        ...process.env,
        NODE_OPTIONS: undefined,
        BUN_OPTIONS: undefined,
        AGENTPOST_API_URL: server.url.href,
        AGENTPOST_API_TOKEN: "node-file-fixture-token",
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    });
  let watcher: ReturnType<typeof spawn> | undefined;
  try {
    const send = spawn([
      "send",
      inbox,
      "--to",
      "fixture@example.invalid",
      "--subject",
      "Fixture",
      "--text-file",
      "text.txt",
      "--html-file",
      "html.txt",
      "--idempotency-key",
      "file-fixture",
    ]);
    assert.equal(await send.exited, 0, await new Response(send.stderr).text());
    assert.equal(JSON.parse(await new Response(send.stdout).text()).status, "pending");
    watcher = spawn(["events", "watch", "--inbox", inbox, "--cursor-file", checkpoint]);
    for (let attempt = 0; attempt < 100; attempt++) {
      if (JSON.parse(await readFile(checkpoint, "utf8")).cursor === "next-cursor") break;
      await delay(20);
    }
    assert.equal(JSON.parse(await readFile(checkpoint, "utf8")).cursor, "next-cursor");
    watcher.kill();
    await watcher.exited;
    const previous = polls;
    await writeFile(checkpoint, "corrupted checkpoint");
    const corrupt = spawn(["events", "watch", "--inbox", inbox, "--cursor-file", checkpoint]);
    assert.equal(await corrupt.exited, 1);
    assert.equal(polls, previous);
    console.log(
      "Node file inputs, checkpoint resume/persistence and corrupt-checkpoint rejection passed",
    );
  } finally {
    watcher?.kill();
    await watcher?.exited;
    await server.stop(true);
  }
}
