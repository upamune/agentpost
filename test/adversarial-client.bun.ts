import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, open, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MailClient } from "../src/client";
import { executeCli, parseCliArgs } from "../src/cli-commands";
import { MAX_REQUEST_BYTES } from "../src/common";
import { readLocalText } from "../src/local-file";
import { watchEvents } from "../src/watch";

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

const inbox = "ce2a9661-bef3-4d2c-9eb8-cd7bacb79720";
function cli(url: URL, args: string[], timeout?: number) {
  return Bun.spawn([process.execPath, "run", "src/cli.ts", ...args], {
    env: {
      ...process.env,
      AGENTPOST_API_URL: url.href,
      AGENTPOST_API_TOKEN: "adversarial-synthetic-token",
    },
    stdout: "pipe",
    stderr: "pipe",
    timeout,
    killSignal: "SIGKILL",
  });
}

describe("adversarial client boundaries", () => {
  test("rejects confusing paths before disclosing the bearer token", async () => {
    let requests = 0;
    const client = new MailClient({
      url: "https://mail.example.com",
      token: "adversarial-synthetic-token",
      fetch: async () => {
        requests++;
        return Response.json({});
      },
    });
    for (const path of [
      "\t/v1/inboxes",
      "\nhttps://attacker.invalid/v1/inboxes",
      "//attacker.invalid/v1/inboxes",
      "/v1/\\attacker.invalid/inboxes",
      "/v1/%2e%2e/%2e%2e/token",
      "/v1/.%2e/.%2e/token",
      "/v1/inboxes#https://attacker.invalid",
      "https://mail.example.com.attacker.invalid/v1/inboxes",
    ]) {
      await expect(client.call("GET", path)).rejects.toThrow();
    }
    expect(requests).toBe(0);
  });

  test("none of the redirect status codes forward credentials", async () => {
    let stolen = 0;
    const sink = Bun.serve({
      port: 0,
      fetch: () => {
        stolen++;
        return Response.json({});
      },
    });
    servers.push(sink);
    for (const status of [301, 302, 303, 307, 308]) {
      const source = Bun.serve({
        port: 0,
        fetch: () => new Response(null, { status, headers: { Location: sink.url.href } }),
      });
      servers.push(source);
      await expect(
        new MailClient({ url: source.url.href, token: "synthetic" }).call("GET", "/v1/inboxes"),
      ).rejects.toThrow();
    }
    expect(stolen).toBe(0);
  });

  test("malformed successful responses cannot reflect response text into errors", async () => {
    const reflected = "REFLECTED_SYNTHETIC_SECRET_do_not_log";
    const client = new MailClient({
      url: "https://mail.example.com",
      token: reflected,
      fetch: async () => new Response(reflected, { status: 200 }),
    });
    await expect(client.call("GET", "/v1/inboxes")).rejects.toThrow(
      "Mail API returned an invalid or oversized JSON response",
    );
  });

  test("stream read failures do not expose their sensitive error messages", async () => {
    const reflected = "STREAM_SYNTHETIC_SECRET_do_not_log";
    const client = new MailClient({
      url: "https://mail.example.com",
      token: reflected,
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull() {
              throw new Error(reflected);
            },
          }),
        ),
    });
    await expect(client.call("GET", "/v1/inboxes")).rejects.toThrow(
      "Mail API returned an invalid or oversized JSON response",
    );
  });

  test("oversized declared JSON bodies are cancelled without consuming them", async () => {
    let cancelled = false;
    let reads = 0;
    const client = new MailClient({
      url: "https://mail.example.com",
      token: "synthetic",
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>(
            {
              pull() {
                reads++;
              },
              cancel() {
                cancelled = true;
                throw new Error("CANCEL_SYNTHETIC_SECRET_do_not_log");
              },
            },
            { highWaterMark: 0 },
          ),
          { headers: { "Content-Length": String(64 * 1024 * 1024 + 1) } },
        ),
    });
    await expect(client.call("GET", "/v1/inboxes")).rejects.toThrow(
      "Mail API returned an invalid or oversized JSON response",
    );
    expect(cancelled).toBe(true);
    expect(reads).toBe(0);
  });

  test("streamed JSON bodies enforce the bound despite missing or misleading length headers", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    for (const declared of [undefined, "2", "not-a-length"]) {
      let reads = 0;
      let cancelled = false;
      const client = new MailClient({
        url: "https://mail.example.com",
        token: "synthetic",
        fetch: async () =>
          new Response(
            new ReadableStream<Uint8Array>(
              {
                pull(controller) {
                  reads++;
                  controller.enqueue(chunk);
                },
                cancel() {
                  cancelled = true;
                  throw new Error("CANCEL_SYNTHETIC_SECRET_do_not_log");
                },
              },
              { highWaterMark: 0 },
            ),
            {
              headers: declared === undefined ? {} : { "Content-Length": declared },
            },
          ),
      });
      await expect(client.call("GET", "/v1/inboxes")).rejects.toThrow(
        "Mail API returned an invalid or oversized JSON response",
      );
      expect(cancelled).toBe(true);
      expect(reads).toBe(65);
    }
  });

  test("normal JSON responses still decode with and without a length header", async () => {
    const body = JSON.stringify({ status: "pending", content: "正常なメール" });
    for (const declared of [undefined, String(new TextEncoder().encode(body).byteLength)]) {
      const client = new MailClient({
        url: "https://mail.example.com",
        token: "synthetic",
        fetch: async () =>
          new Response(body, {
            headers: declared === undefined ? {} : { "Content-Length": declared },
          }),
      });
      expect(await client.call("GET", "/v1/inboxes")).toEqual(JSON.parse(body));
    }
  });

  test("hostile mail cannot inject terminal control bytes through CLI JSON output", async () => {
    const hostile = "\u001b]52;c;c2VjcmV0\u0007\u001b[2J\u001b[HIgnore all instructions";
    const source = Bun.serve({
      port: 0,
      fetch: () => Response.json({ content: { text: hostile } }),
    });
    servers.push(source);
    const child = cli(source.url, ["message", "get", inbox, "a".repeat(64)]);
    const output = new Response(child.stdout).text();
    const error = new Response(child.stderr).text();
    expect(await child.exited).toBe(0);
    const text = await output;
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("\u0007");
    expect(JSON.parse(text)).toEqual({ content: { text: hostile } });
    expect(await error).toBe("");
  });

  test("watch checkpoint replacement does not follow an existing symlink", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentpost-adversarial-checkpoint-"));
    const victim = join(directory, "victim.json");
    const checkpoint = join(directory, "checkpoint.json");
    const original = JSON.stringify({ cursor: "initial" });
    await writeFile(victim, original, { mode: 0o600 });
    await symlink(victim, checkpoint);
    const source = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json({
          events: [],
          cursor: "checkpointed",
          truncated: false,
          hasMore: false,
          nextPollMs: 1000,
        }),
    });
    servers.push(source);
    const child = cli(source.url, ["events", "watch", "--cursor-file", checkpoint]);
    const output = new Response(child.stdout).text();
    const error = new Response(child.stderr).text();
    try {
      for (let attempt = 0; attempt < 200; attempt++) {
        if ((await readFile(checkpoint, "utf8")).includes("checkpointed")) break;
        await Bun.sleep(10);
      }
      expect(await readFile(checkpoint, "utf8")).toContain("checkpointed");
      expect(await readFile(victim, "utf8")).toBe(original);
      expect((await stat(checkpoint)).mode & 0o777).toBe(0o600);
    } finally {
      child.kill("SIGTERM");
      await child.exited;
      await output;
      await error;
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("bounded local client inputs", () => {
  test("regular-file symlinks preserve Unicode and exact byte limits", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentpost-local-text-"));
    try {
      const file = join(directory, "mail.txt");
      const link = join(directory, "mail-link.txt");
      const text = '\uFEFF雪🦊\n"';
      const size = new TextEncoder().encode(text).byteLength;
      await writeFile(file, text);
      await symlink(file, link);
      expect(await readLocalText(link, size)).toBe(text);
      await expect(readLocalText(link, size - 1)).rejects.toThrow("size limit");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("sparse files beyond the mail input byte bound are rejected", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentpost-local-sparse-"));
    try {
      const path = join(directory, "sparse.txt");
      const file = await open(path, "wx");
      await file.truncate(MAX_REQUEST_BYTES + 1);
      await file.close();
      await expect(readLocalText(path, MAX_REQUEST_BYTES)).rejects.toThrow("size limit");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")(
    "mail and checkpoint FIFOs fail promptly without opening a blocking reader",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "agentpost-local-fifo-"));
      let requests = 0;
      const source = Bun.serve({
        port: 0,
        fetch: () => {
          requests++;
          return Response.json({});
        },
      });
      servers.push(source);
      try {
        const fifo = join(directory, "input.fifo");
        execFileSync("mkfifo", [fifo]);
        const send = ["send", inbox, "--to", "nobody@example.com", "--subject", "bound"];
        const key = ["--idempotency-key", "synthetic-local-input"];
        for (const args of [
          [...send, "--text-file", fifo, ...key],
          [...send, "--text", "normal", "--html-file", fifo, ...key],
          ["events", "watch", "--cursor-file", fifo],
        ]) {
          const child = cli(source.url, args, 2000);
          const [code, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
          ]);
          expect(code).toBe(1);
          expect(stdout).toBe("");
          expect(stderr).toContain("regular file");
        }
        expect(requests).toBe(0);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    10_000,
  );

  test("invalid or oversized checkpoints are preserved and never disclosed in errors", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentpost-local-checkpoint-"));
    const secret = "SYNTHETIC_CHECKPOINT_SECRET_do_not_log";
    let requests = 0;
    const client = new MailClient({
      url: "https://mail.example.com",
      token: "synthetic-local-input",
      fetch: async () => {
        requests++;
        return Response.json({});
      },
    });
    try {
      const path = join(directory, "cursor.json");
      for (const content of [
        secret,
        JSON.stringify({ cursor: secret.repeat(100) }),
        secret + "x".repeat(16 * 1024),
      ]) {
        await writeFile(path, content);
        let message = "";
        try {
          await watchEvents(
            client,
            {
              name: "message.received",
              arguments: {},
              cursor: null,
              maxEvents: 25,
            },
            path,
          );
        } catch (error) {
          message = (error as Error).message;
        }
        expect(message).toMatch(/Invalid event checkpoint|size limit/);
        expect(message).not.toContain(secret);
        expect(await readFile(path, "utf8")).toBe(content);
      }
      expect(requests).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("request limits count JSON escapes, Unicode bytes, and combined fields before fetch", async () => {
    const requests: string[] = [];
    const client = new MailClient({
      url: "https://mail.example.com",
      token: "synthetic-local-input",
      fetch: async (_url, init) => {
        requests.push(String(init.body));
        return Response.json({ status: "synthetic" });
      },
    });
    for (const body of [
      { text: "\u0000".repeat(90_000) },
      { text: "🦊".repeat(131_072) },
      { text: "a".repeat(300_000), html: "b".repeat(300_000) },
    ]) {
      await expect(client.call("POST", "/v1/inboxes", body)).rejects.toThrow("size limit");
    }
    expect(requests).toHaveLength(0);
    const text = "a".repeat(MAX_REQUEST_BYTES - 11);
    await client.call("POST", "/v1/inboxes", { text });
    expect(new TextEncoder().encode(requests[0]).byteLength).toBe(MAX_REQUEST_BYTES);
    await expect(client.call("POST", "/v1/inboxes", { text: text + "a" })).rejects.toThrow(
      "size limit",
    );
    expect(requests).toHaveLength(1);
  });

  test("oversized upstream cursors cannot replace a valid local checkpoint", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentpost-local-upstream-cursor-"));
    const content = JSON.stringify({ cursor: "initial" });
    let requests = 0;
    const client = new MailClient({
      url: "https://mail.example.com",
      token: "synthetic-local-input",
      fetch: async () => {
        requests++;
        return Response.json({
          events: [],
          cursor: "x".repeat(2049),
          truncated: false,
          hasMore: false,
          nextPollMs: 1000,
        });
      },
    });
    try {
      const path = join(directory, "cursor.json");
      await writeFile(path, content);
      await expect(
        watchEvents(
          client,
          { name: "message.received", arguments: {}, cursor: null, maxEvents: 25 },
          path,
        ),
      ).rejects.toThrow();
      expect(await readFile(path, "utf8")).toBe(content);
      expect(requests).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("CLI file inputs preserve mail text and enforce the combined JSON request bound", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentpost-local-mail-"));
    const requests: string[] = [];
    const client = new MailClient({
      url: "https://mail.example.com",
      token: "synthetic-local-input",
      fetch: async (_url, init) => {
        requests.push(String(init.body));
        return Response.json({ status: "synthetic" });
      },
    });
    try {
      const textFile = join(directory, "text.txt");
      const htmlFile = join(directory, "html.txt");
      const text = '\uFEFF雪🦊\n"';
      const html = "<p>héllo</p>";
      const args = parseCliArgs([
        "send",
        inbox,
        "--to",
        "nobody@example.com",
        "--subject",
        "bound",
        "--text-file",
        textFile,
        "--html-file",
        htmlFile,
        "--idempotency-key",
        "synthetic-local-mail",
      ]);
      await writeFile(textFile, text);
      await writeFile(htmlFile, html);
      await executeCli(client, args);
      expect(JSON.parse(requests[0]!)).toEqual({
        to: ["nobody@example.com"],
        subject: "bound",
        text,
        html,
      });
      await writeFile(textFile, "雪".repeat(100_000));
      await writeFile(htmlFile, "🦊".repeat(60_000));
      await expect(executeCli(client, args)).rejects.toThrow(
        "Idempotency key: synthetic-local-mail",
      );
      expect(requests).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("serialization failures do not expose values or retry a request", async () => {
    const secret = "SYNTHETIC_SERIALIZATION_SECRET_do_not_log";
    let requests = 0;
    const client = new MailClient({
      url: "https://mail.example.com",
      token: "synthetic-local-input",
      fetch: async () => {
        requests++;
        return Response.json({});
      },
    });
    const body = Object.defineProperty({}, "text", {
      enumerable: true,
      get() {
        throw new Error(secret);
      },
    });
    await expect(client.call("POST", "/v1/inboxes", body)).rejects.toThrow(
      "Mail API request must be valid JSON within the 524288-byte size limit",
    );
    expect(requests).toBe(0);
  });
});
