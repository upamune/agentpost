import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, test } from "vitest";
import app from "../src/api";
import { MAX_MAIL_BYTES, sha256 } from "../src/common";
import { parseMessage, receive, repairRawIndex } from "../src/inbound";
import { maintain } from "../src/maintenance";
import { cloudflareSend } from "../src/outbound";
import { deliver } from "./delivery";
import type { Env, Message, Outbox, SendPayload } from "../src/types";

const bindings: Env = env;
const admin = "test-admin-token-with-at-least-32-characters";
type CreatedInbox = { id: string; address: string; token: string };

async function request(
  path: string,
  options: { method?: string; token?: string; body?: unknown; key?: string } = {},
) {
  return app.request(
    `https://mail.test${path}`,
    {
      method: options.method ?? "GET",
      headers: {
        Authorization: `Bearer ${options.token ?? admin}`,
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(options.key ? { "Idempotency-Key": options.key } : {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    },
    bindings,
  );
}

async function inbox(): Promise<CreatedInbox> {
  const response = await request("/v1/inboxes", { method: "POST", body: { label: "test" } });
  expect(response.status).toBe(201);
  return response.json();
}

async function send(box: CreatedInbox, key = "send-test", text = "Hello") {
  const response = await request(`/v1/inboxes/${box.id}/send`, {
    method: "POST",
    token: box.token,
    key,
    body: { to: ["recipient@example.net"], subject: "Test", text },
  });
  return { response, row: (await response.json()) as Outbox };
}

function email(to: string, raw: string, size = new TextEncoder().encode(raw).byteLength) {
  const rejected: string[] = [];
  const input = {
    from: "sender@example.net",
    to,
    headers: new Headers(),
    raw: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(raw));
        controller.close();
      },
    }),
    rawSize: size,
    canBeForwarded: true,
    setReject(reason: string) {
      rejected.push(reason);
    },
    forward() {
      throw new Error("Forward not expected");
    },
    reply() {
      throw new Error("Automatic reply not expected");
    },
  };
  return { input, rejected };
}

const mime = [
  "From: Sender <sender@example.net>",
  "Reply-To: replies@example.net",
  "To: agent@example.com",
  "Subject: Verification",
  "Message-ID: <test-1@example.net>",
  "MIME-Version: 1.0",
  "Content-Type: multipart/mixed; boundary=mailboundary",
  "",
  "--mailboundary",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Your code is 123456.",
  "--mailboundary",
  "Content-Type: text/plain",
  'Content-Disposition: attachment; filename="hello.txt"',
  "Content-Transfer-Encoding: base64",
  "",
  "SGVsbG8h",
  "--mailboundary--",
  "",
].join("\r\n");

beforeEach(async () => {
  await reset();
  await applyD1Migrations(bindings.DB, env.TEST_MIGRATIONS);
});

describe("API and inbox isolation", () => {
  test("rotating an inbox token revokes the old token without changing its address", async () => {
    const box = await inbox();
    expect(
      (await request(`/v1/inboxes/${box.id}/token`, { method: "POST", token: box.token })).status,
    ).toBe(403);
    const response = await request(`/v1/inboxes/${box.id}/token`, { method: "POST" });
    const rotated = (await response.json()) as { token: string };
    expect(rotated.token).not.toBe(box.token);
    expect((await request(`/v1/inboxes/${box.id}`, { token: box.token })).status).toBe(401);
    const accessible = await request(`/v1/inboxes/${box.id}`, { token: rotated.token });
    expect(((await accessible.json()) as { address: string }).address).toBe(box.address);
  });

  test("requires authentication and refuses to start without a strong admin secret", async () => {
    expect((await app.request("https://mail.test/v1/inboxes", {}, bindings)).status).toBe(401);
    expect(
      (
        await app.request(
          "https://mail.test/v1/inboxes",
          {},
          { ...bindings, AGENTPOST_ADMIN_TOKEN: "" },
        )
      ).status,
    ).toBe(503);
    const exampleToken = "replace-with-a-random-secret-at-least-32-characters";
    expect(
      (
        await app.request(
          "https://mail.test/v1/inboxes",
          { headers: { Authorization: `Bearer ${exampleToken}` } },
          { ...bindings, AGENTPOST_ADMIN_TOKEN: exampleToken },
        )
      ).status,
    ).toBe(503);
  });

  test("issues random unique addresses and stores only token hashes", async () => {
    const first = await inbox();
    const second = await inbox();
    expect(first.address).toMatch(/^[a-z]+-[a-z]+-[a-z]+@example\.com$/);
    expect(first.address).not.toBe(second.address);
    const row = await bindings.DB.prepare("SELECT token_hash FROM inboxes WHERE id = ?")
      .bind(first.id)
      .first<{ token_hash: string }>();
    expect(row?.token_hash).toBe(await sha256(first.token));
    expect(row?.token_hash).not.toBe(first.token);
  });

  test("custom names are canonical, bounded, and keep the configured domain", async () => {
    for (const name of ["Research.Team+2026_1-dev", "a", "x".repeat(64)]) {
      const response = await request("/v1/inboxes", { method: "POST", body: { local_part: name } });
      expect(response.status).toBe(201);
      const box = await response.json<CreatedInbox>();
      expect(box.address).toBe(`${name.toLowerCase()}@example.com`);
      expect((await request(`/v1/inboxes/${box.id}`, { token: box.token })).status).toBe(200);
    }
  });

  test("concurrent case-insensitive name claims create one inbox without replacing credentials", async () => {
    const responses = await Promise.all(
      ["Research", "RESEARCH"].map((local_part, index) =>
        request("/v1/inboxes", { method: "POST", body: { local_part, label: `claim-${index}` } }),
      ),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    const winner = await responses
      .find((response) => response.status === 201)!
      .json<CreatedInbox>();
    const conflict = await responses.find((response) => response.status === 409)!.json();
    expect(conflict).toEqual({ error: "Email address already exists" });
    const row = await bindings.DB.prepare("SELECT id, token_hash FROM inboxes WHERE address = ?")
      .bind("research@example.com")
      .first<{ id: string; token_hash: string }>();
    expect(row?.id).toBe(winner.id);
    expect(row?.token_hash).toBe(await sha256(winner.token));
    expect(
      (await bindings.DB.prepare("SELECT count(*) AS count FROM inboxes").first())?.count,
    ).toBe(1);
  });

  test("disabled names stay reserved and cannot be reclaimed with a new token", async () => {
    const created = await request("/v1/inboxes", {
      method: "POST",
      body: { local_part: "reserved" },
    });
    const box = await created.json<CreatedInbox>();
    expect(
      (await request(`/v1/inboxes/${box.id}`, { method: "PATCH", body: { active: false } })).status,
    ).toBe(200);
    const conflict = await request("/v1/inboxes", {
      method: "POST",
      body: { local_part: "RESERVED" },
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "Email address already exists" });
    const row = await bindings.DB.prepare(
      "SELECT id, active, token_hash FROM inboxes WHERE address = ?",
    )
      .bind(box.address)
      .first<{ id: string; active: number; token_hash: string }>();
    expect(row).toEqual({ id: box.id, active: 0, token_hash: await sha256(box.token) });
  });

  test("invalid mailbox names and full addresses are rejected before allocation", async () => {
    for (const name of [
      "",
      "x".repeat(65),
      ".first",
      "last.",
      "two..dots",
      " space",
      "space ",
      "two names",
      "name@example.net",
      "name/child",
      "name\\child",
      "name%2e",
      "名前",
      "name\r\nBcc:other",
      "a\0b",
      null,
      123,
    ]) {
      const response = await request("/v1/inboxes", { method: "POST", body: { local_part: name } });
      expect(response.status).toBe(400);
    }
    expect(
      (await bindings.DB.prepare("SELECT count(*) AS count FROM inboxes").first())?.count,
    ).toBe(0);
  });

  test("combined address length is validated without changing the configured domain", async () => {
    const longDomain = ["b".repeat(63), "c".repeat(63), "d".repeat(63), "example", "com"].join(".");
    const response = await app.request(
      "https://mail.test/v1/inboxes",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${admin}`, "Content-Type": "application/json" },
        body: JSON.stringify({ local_part: "x".repeat(64) }),
      },
      { ...bindings, AGENTPOST_EMAIL_DOMAIN: longDomain },
    );
    expect(response.status).toBe(400);
    expect(
      (await bindings.DB.prepare("SELECT count(*) AS count FROM inboxes").first())?.count,
    ).toBe(0);
  });

  test("a named inbox receives mail and persists sends using its canonical address", async () => {
    const created = await request("/v1/inboxes", {
      method: "POST",
      body: { local_part: "Research.Team+1" },
    });
    const box = await created.json<CreatedInbox>();
    const incoming = email(box.address.toUpperCase(), mime);
    await receive(incoming.input, bindings);
    expect(incoming.rejected).toEqual([]);
    const message = await bindings.DB.prepare("SELECT id FROM messages WHERE inbox_id = ?")
      .bind(box.id)
      .first<{ id: string }>();
    expect(message).not.toBeNull();
    await parseMessage(bindings, message!.id);
    expect(
      (await request(`/v1/inboxes/${box.id}/messages/${message!.id}`, { token: box.token })).status,
    ).toBe(200);
    const { response, row } = await send(box, "named-inbox");
    expect(response.status).toBe(202);
    const stored = await bindings.DB.prepare("SELECT payload FROM outbox WHERE id = ?")
      .bind(row.id)
      .first<{ payload: string }>();
    expect(JSON.parse(stored!.payload).from).toBe("research.team+1@example.com");
  });

  test("an inbox token cannot provision, list, or access other inboxes", async () => {
    const first = await inbox();
    const second = await inbox();
    expect((await request("/v1/inboxes", { token: first.token })).status).toBe(403);
    expect(
      (await request("/v1/inboxes", { method: "POST", body: {}, token: first.token })).status,
    ).toBe(403);
    expect(
      (await request(`/v1/inboxes/${second.id}/messages`, { token: first.token })).status,
    ).toBe(404);
    expect(
      (
        await request("/v1/inboxes", {
          method: "POST",
          body: { local_part: "research" },
          token: first.token,
        })
      ).status,
    ).toBe(403);
    expect((await request(`/v1/inboxes/${first.id}`, { token: first.token })).status).toBe(200);
  });

  test("disabling an inbox revokes its token and rejects future mail", async () => {
    const box = await inbox();
    expect(
      (await request(`/v1/inboxes/${box.id}`, { method: "PATCH", body: { active: false } })).status,
    ).toBe(200);
    expect((await request(`/v1/inboxes/${box.id}`, { token: box.token })).status).toBe(401);
    const incoming = email(box.address, mime);
    await receive(incoming.input, bindings);
    expect(incoming.rejected).toEqual(["Unknown or disabled recipient"]);
  });

  test("rejects sender override, header injection, invalid keys, invalid pagination and oversized bodies", async () => {
    const box = await inbox();
    const path = `/v1/inboxes/${box.id}/send`;
    const body = { to: ["a@example.net"], subject: "test", text: "body" };
    expect(
      (
        await request(path, {
          method: "POST",
          key: "a",
          body: { ...body, from: "other@example.net" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(path, {
          method: "POST",
          key: "a",
          body: { ...body, subject: "hello\r\nBcc: other@example.net" },
        })
      ).status,
    ).toBe(400);
    expect((await request(path, { method: "POST", body, key: "invalid key" })).status).toBe(400);
    expect((await request(`/v1/inboxes/${box.id}/messages?limit=-1`)).status).toBe(400);
    expect(
      (
        await request(path, {
          method: "POST",
          key: "a",
          body: { ...body, text: "x".repeat(600_000) },
        })
      ).status,
    ).toBe(413);
  });
});

describe("durable inbound processing", () => {
  test("MIME resource limits leave the original recoverable when parsing is refused", async () => {
    const box = await inbox();
    const raw = `From: sender@example.net\r\nX-Oversized: ${"a".repeat(129 * 1024)}\r\n\r\nBody`;
    await receive(email(box.address, raw).input, bindings);
    const message = await bindings.DB.prepare("SELECT * FROM messages").first<Message>();
    expect(message).not.toBeNull();
    await expect(parseMessage(bindings, message!.id)).rejects.toThrow();
    expect(await (await bindings.MAIL.get(message!.raw_key))?.text()).toBe(raw);
    expect(await bindings.MAIL.head(`parsed/${message!.id}.json`)).toBeNull();
  });

  test("cursor pagination does not skip messages with equal timestamps", async () => {
    const box = await inbox();
    for (const suffix of ["one", "two", "three"]) {
      await receive(
        email(box.address, mime.replace("test-1@example.net", `${suffix}@example.net`)).input,
        bindings,
      );
    }
    await bindings.DB.prepare("UPDATE messages SET created_at = 1234").run();
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const result = await request(
        `/v1/inboxes/${box.id}/messages?limit=1${cursor ? `&cursor=${cursor}` : ""}`,
      );
      const page = (await result.json()) as { items: { id: string }[]; next_cursor: string | null };
      seen.push(...page.items.map((message) => message.id));
      cursor = page.next_cursor;
    } while (cursor);
    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3);
  });

  test("rejects unissued addresses without storing arbitrary mail", async () => {
    const incoming = email("unissued@example.com", mime);
    await receive(incoming.input, bindings);
    expect(incoming.rejected).toEqual(["Unknown or disabled recipient"]);
    expect((await bindings.MAIL.list()).objects).toHaveLength(0);
  });

  test("rejects messages over the configured size cap", async () => {
    const box = await inbox();
    const incoming = email(box.address, mime, MAX_MAIL_BYTES + 1);
    await receive(incoming.input, bindings);
    expect(incoming.rejected).toEqual(["Message exceeds 10 MiB limit"]);
    expect((await bindings.MAIL.list()).objects).toHaveLength(0);
  });

  test("persists MIME, deduplicates delivery, parses text and exposes attachments", async () => {
    const box = await inbox();
    await receive(email(box.address, mime).input, bindings);
    await receive(email(box.address, mime).input, bindings);
    const rows = await bindings.DB.prepare("SELECT * FROM messages").all<Message>();
    expect(rows.results).toHaveLength(1);
    const row = rows.results[0];
    expect(row.status).toBe("pending");
    expect(await (await bindings.MAIL.get(row.raw_key))?.text()).toBe(mime);
    await parseMessage(bindings, row.id);
    const response = await request(`/v1/inboxes/${box.id}/messages/${row.id}`, {
      token: box.token,
    });
    const result = (await response.json()) as {
      status: string;
      content: { text: string; attachments: { filename: string }[] };
    };
    expect(result.status).toBe("ready");
    expect(result.content.text).toContain("123456");
    expect(result.content.attachments[0].filename).toBe("hello.txt");
    const download = await request(`/v1/inboxes/${box.id}/messages/${row.id}/attachments/0`, {
      token: box.token,
    });
    expect(await download.text()).toBe("Hello!");
    const raw = await request(`/v1/inboxes/${box.id}/messages/${row.id}/raw`);
    expect(await raw.text()).toBe(mime);
  });

  test("survives queue publishing failure and recovers a missing D1 index from R2", async () => {
    const box = await inbox();
    const offlineQueue: Env["JOBS"] = {
      ...bindings.JOBS,
      send: async () => {
        throw new Error("Queue unavailable");
      },
    };
    await receive(email(box.address, mime).input, { ...bindings, JOBS: offlineQueue });
    const row = await bindings.DB.prepare("SELECT * FROM messages").first<Message>();
    expect(row?.status).toBe("pending");
    await bindings.DB.prepare("DELETE FROM forwarding_deliveries").run();
    await bindings.DB.prepare("DELETE FROM messages").run();
    await repairRawIndex(bindings);
    const restored = await bindings.DB.prepare("SELECT * FROM messages").first<Message>();
    expect(restored?.id).toBe(row?.id);
    await parseMessage(bindings, restored!.id);
    expect((await bindings.DB.prepare("SELECT status FROM messages").first())?.status).toBe(
      "ready",
    );
  });

  test("keeps different inboxes separate for identical raw messages", async () => {
    const a = await inbox();
    const b = await inbox();
    await receive(email(a.address, mime).input, bindings);
    await receive(email(b.address, mime).input, bindings);
    const rows = await bindings.DB.prepare(
      "SELECT * FROM messages ORDER BY inbox_id",
    ).all<Message>();
    expect(rows.results).toHaveLength(2);
    expect(rows.results[0].id).not.toBe(rows.results[1].id);
    expect(
      (
        await request(
          `/v1/inboxes/${a.id}/messages/${rows.results.find((row) => row.inbox_id === b.id)!.id}`,
          { token: a.token },
        )
      ).status,
    ).toBe(404);
  });

  test("replies use Reply-To and retain threading headers", async () => {
    const box = await inbox();
    await receive(email(box.address, mime).input, bindings);
    const row = await bindings.DB.prepare("SELECT * FROM messages").first<Message>();
    await parseMessage(bindings, row!.id);
    const response = await request(`/v1/inboxes/${box.id}/messages/${row!.id}/reply`, {
      method: "POST",
      body: { text: "Thanks" },
      key: "reply-one",
    });
    expect(response.status).toBe(202);
    const result = (await response.json()) as { payload: SendPayload };
    expect(result.payload.to).toEqual(["replies@example.net"]);
    expect(result.payload.from).toBe(box.address);
    expect(result.payload.subject).toBe("Re: Verification");
    expect(result.payload.headers?.["In-Reply-To"]).toBe("<test-1@example.net>");
  });
});

describe("outbox and failure recovery", () => {
  test("R2 recovery failure does not stop pending outbound work from being republished", async () => {
    const { row } = await send(await inbox());
    const published: string[] = [];
    const offline: Env = {
      ...bindings,
      MAIL: {
        ...bindings.MAIL,
        list: async () => {
          throw new Error("R2 unavailable");
        },
      },
      JOBS: {
        ...bindings.JOBS,
        send: async (job, options) => {
          published.push(job.id);
          return bindings.JOBS.send(job, options);
        },
      },
    };
    await expect(maintain(offline)).rejects.toThrow("Scheduled recovery failed");
    expect(published).toContain(row.id);
  });

  test("only an admin can reconcile a send, and reconciliation never sends again", async () => {
    const box = await inbox();
    const { row } = await send(box);
    await deliver(bindings, row.id, async () => ({ status: "unknown", error: "Timeout" }));
    const path = `/v1/inboxes/${box.id}/outbox/${row.id}/resolve`;
    const body = { outcome: "accepted", note: "Verified provider log record test-123" };
    expect((await request(path, { method: "POST", token: box.token, body })).status).toBe(403);
    const response = await request(path, { method: "POST", body });
    expect(response.status).toBe(200);
    const resolved = (await response.json()) as Outbox;
    expect(resolved.status).toBe("accepted");
    expect(resolved.resolution_note).toBe(body.note);
    let sends = 0;
    await deliver(bindings, row.id, async () => {
      sends++;
      return { status: "accepted", result: "{}" };
    });
    expect(sends).toBe(0);
    expect((await request("/v1/health")).status).toBe(200);
  });

  test("health reports overdue work even while the Worker is alive", async () => {
    const { row } = await send(await inbox());
    await bindings.DB.prepare("UPDATE outbox SET created_at = ? WHERE id = ?")
      .bind(Date.now() - 16 * 60_000, row.id)
      .run();
    expect((await request("/healthz")).status).toBe(200);
    expect((await request("/v1/health")).status).toBe(503);
  });

  test.each([
    [0, 200],
    [14, 200],
    [16, 503],
  ])(
    "health detects sending stalled for %i minutes without changing its outcome",
    async (minutes, status) => {
      const { row } = await send(await inbox());
      const updated = Date.now() - minutes * 60_000;
      await bindings.DB.prepare(
        "UPDATE outbox SET status = 'sending', created_at = ?, updated_at = ? WHERE id = ?",
      )
        .bind(Date.now() - 60 * 60_000, updated, row.id)
        .run();
      const response = await request("/v1/health");
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ oldest_sending: updated });
      expect(
        await bindings.DB.prepare("SELECT status, updated_at FROM outbox WHERE id = ?")
          .bind(row.id)
          .first(),
      ).toEqual({ status: "sending", updated_at: updated });
    },
  );

  test.each([
    [429, "retry"],
    [400, "failed"],
    [403, "failed"],
    [500, "unknown"],
    [503, "unknown"],
    [408, "unknown"],
  ] as const)("provider HTTP %i is classified as %s", async (status, expected) => {
    const result = await cloudflareSend(
      bindings,
      { from: "a@example.com", to: ["b@example.net"], subject: "Test", text: "Body" },
      async () => new Response("{}", { status }),
    );
    expect(result.status).toBe(expected);
  });

  test("a truncated success response and a network error remain unknown", async () => {
    const payload = { from: "a@example.com", to: ["b@example.net"], subject: "Test", text: "Body" };
    expect(
      (
        await cloudflareSend(
          bindings,
          payload,
          async () => new Response("{truncated", { status: 200 }),
        )
      ).status,
    ).toBe("unknown");
    expect(
      (
        await cloudflareSend(bindings, payload, async () => {
          throw new Error("network");
        })
      ).status,
    ).toBe("unknown");
  });

  test("provider acceptance is recorded without claiming recipient delivery", async () => {
    const payload = { from: "a@example.com", to: ["b@example.net"], subject: "Test", text: "Body" };
    const result = await cloudflareSend(bindings, payload, async (url, init) => {
      expect(url).toBe(
        "https://api.cloudflare.com/client/v4/accounts/test-account/email/sending/send",
      );
      expect(init.method).toBe("POST");
      expect(init.headers).toEqual({
        Authorization: "Bearer test-provider-token",
        "Content-Type": "application/json",
      });
      expect(JSON.parse(String(init.body))).toEqual(payload);
      return Response.json({ success: true, result: { queued: ["b@example.net"] } });
    });
    expect(result.status).toBe("accepted");
  });

  test("retries the same request without creating another send and rejects reused keys with different contents", async () => {
    const box = await inbox();
    const first = await send(box);
    const second = await send(box);
    expect(first.response.status).toBe(202);
    expect(second.row.id).toBe(first.row.id);
    expect((await send(box, "send-test", "Different")).response.status).toBe(409);
    expect((await bindings.DB.prepare("SELECT count(*) AS count FROM outbox").first())?.count).toBe(
      1,
    );
  });

  test("concurrent duplicate jobs call the provider only once", async () => {
    const { row } = await send(await inbox());
    let calls = 0;
    const sender = async () => {
      calls++;
      return { status: "accepted" as const, result: '{"queued":["recipient@example.net"]}' };
    };
    await Promise.all([deliver(bindings, row.id, sender), deliver(bindings, row.id, sender)]);
    expect(calls).toBe(1);
    expect(
      (await bindings.DB.prepare("SELECT status FROM outbox WHERE id = ?").bind(row.id).first())
        ?.status,
    ).toBe("accepted");
  });

  test("unknown outcomes never cause an automatic resend", async () => {
    const { row } = await send(await inbox());
    let calls = 0;
    const sender = async () => {
      calls++;
      return { status: "unknown" as const, error: "Timeout" };
    };
    await deliver(bindings, row.id, sender);
    await deliver(bindings, row.id, sender);
    await maintain(bindings);
    expect(calls).toBe(1);
    expect(
      (await bindings.DB.prepare("SELECT status FROM outbox WHERE id = ?").bind(row.id).first())
        ?.status,
    ).toBe("unknown");
    expect((await request("/v1/health")).status).toBe(503);
  });

  test("rate limiting schedules a bounded retry and does not send early", async () => {
    const { row } = await send(await inbox());
    let calls = 0;
    const sender = async () => {
      calls++;
      return { status: "retry" as const, delay: 60, error: "429" };
    };
    await deliver(bindings, row.id, sender);
    await deliver(bindings, row.id, sender);
    expect(calls).toBe(1);
    const queued = await bindings.DB.prepare("SELECT * FROM outbox WHERE id = ?")
      .bind(row.id)
      .first<Outbox>();
    expect(queued?.status).toBe("pending");
    expect(queued!.available_at).toBeGreaterThan(Date.now());
    await bindings.DB.prepare("UPDATE outbox SET available_at = 0, attempts = 7 WHERE id = ?")
      .bind(row.id)
      .run();
    await deliver(bindings, row.id, sender);
    expect(
      (await bindings.DB.prepare("SELECT status FROM outbox WHERE id = ?").bind(row.id).first())
        ?.status,
    ).toBe("failed");
  });

  test("a crash during a provider call becomes unknown instead of being resent", async () => {
    const { row } = await send(await inbox());
    await bindings.DB.prepare("UPDATE outbox SET status = 'sending', updated_at = ? WHERE id = ?")
      .bind(Date.now() - 180_000, row.id)
      .run();
    await maintain(bindings);
    expect(
      (await bindings.DB.prepare("SELECT status FROM outbox WHERE id = ?").bind(row.id).first())
        ?.status,
    ).toBe("unknown");
  });

  test("queue publishing failure still returns a durable outbox ID", async () => {
    const box = await inbox();
    const offline: Env = {
      ...bindings,
      JOBS: {
        ...bindings.JOBS,
        send: async () => {
          throw new Error("offline");
        },
      },
    };
    const response = await app.request(
      `https://mail.test/v1/inboxes/${box.id}/send`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${box.token}`,
          "Content-Type": "application/json",
          "Idempotency-Key": "offline",
        },
        body: JSON.stringify({ to: ["recipient@example.net"], subject: "Hello", text: "Saved" }),
      },
      offline,
    );
    expect(response.status).toBe(202);
    const row = (await response.json()) as Outbox;
    expect(
      (await bindings.DB.prepare("SELECT status FROM outbox WHERE id = ?").bind(row.id).first())
        ?.status,
    ).toBe("pending");
  });

  test("a disabled inbox cannot send previously queued messages", async () => {
    const box = await inbox();
    const { row } = await send(box);
    await request(`/v1/inboxes/${box.id}`, { method: "PATCH", body: { active: false } });
    let calls = 0;
    await deliver(bindings, row.id, async () => {
      calls++;
      return { status: "accepted", result: "{}" };
    });
    expect(calls).toBe(0);
    expect(
      (await bindings.DB.prepare("SELECT status FROM outbox WHERE id = ?").bind(row.id).first())
        ?.status,
    ).toBe("failed");
  });

  test("provider is never called if its credentials are missing", async () => {
    expect(
      await cloudflareSend(
        { ...bindings, AGENTPOST_CF_EMAIL_API_TOKEN: "" },
        { from: "a@example.com", to: ["b@example.net"], subject: "test", text: "body" },
      ),
    ).toEqual({ status: "failed", error: "Email Sending credentials are not configured" });
  });
});
