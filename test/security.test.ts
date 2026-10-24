import { applyD1Migrations, createExecutionContext, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, test } from "vitest";
import worker from "../src/index";
import app from "../src/api";
import type { Env } from "../src/types";

const bindings: Env = env;
const admin = "test-admin-token-with-at-least-32-characters";

beforeEach(async () => {
  await reset();
  await applyD1Migrations(bindings.DB, env.TEST_MIGRATIONS);
});

async function createInbox() {
  const response = await app.request(
    "https://mail.test/v1/inboxes",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${admin}`, "Content-Type": "application/json" },
      body: "{}",
    },
    bindings,
  );
  expect(response.status).toBe(201);
  return response.json<{ id: string; token: string }>();
}

describe("HTTP security boundary", () => {
  test("API and MCP reject foreign, opaque, and empty origins before authorization", async () => {
    for (const path of ["/v1/inboxes", "/mcp"]) {
      for (const origin of ["https://evil.test", "https://mail.test:444", "null", ""]) {
        const response = await worker.fetch(
          new Request(`https://mail.test${path}`, {
            headers: { Origin: origin, Authorization: `Bearer ${admin}` },
          }),
          bindings,
          createExecutionContext(),
        );
        expect(response.status).toBe(403);
        expect(response.headers.get("Cache-Control")).toBe("no-store");
        expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
      }
    }
    const crossSite = await worker.fetch(
      new Request("https://mail.test/v1/inboxes", {
        headers: { "Sec-Fetch-Site": "cross-site", Authorization: `Bearer ${admin}` },
      }),
      bindings,
      createExecutionContext(),
    );
    expect(crossSite.status).toBe(403);
    const sameOrigin = await worker.fetch(
      new Request("https://mail.test/v1/inboxes", {
        headers: { Origin: "https://mail.test", Authorization: `Bearer ${admin}` },
      }),
      bindings,
      createExecutionContext(),
    );
    expect(sameOrigin.status).toBe(200);
  });

  test("HTTPS is required outside loopback and error responses get security headers", async () => {
    for (const url of [
      "https://mail.test/v1/inboxes",
      "https://mail.test/mcp",
      "https://mail.test/missing",
      "http://mail.test/v1/inboxes",
    ]) {
      const response = await worker.fetch(new Request(url), bindings, createExecutionContext());
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.headers.get("Content-Security-Policy")).toContain("sandbox");
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
      expect(response.headers.get("X-Frame-Options")).toBe("DENY");
      expect(response.headers.get("Strict-Transport-Security")).toBe(
        url.startsWith("https:") ? "max-age=31536000" : null,
      );
    }
    expect(
      (
        await worker.fetch(
          new Request("http://127.0.0.1/healthz"),
          bindings,
          createExecutionContext(),
        )
      ).status,
    ).toBe(200);
  });

  test("request limits apply before authentication and store a hash instead of the raw IP", async () => {
    const keys: string[] = [];
    const limited: Env = {
      ...bindings,
      AGENTPOST_REQUEST_LIMITER: {
        limit: async ({ key }) => {
          keys.push(key);
          return { success: false };
        },
      },
    };
    for (const path of ["/v1/inboxes", "/mcp"]) {
      const response = await worker.fetch(
        new Request(`https://mail.test${path}`, {
          headers: { "CF-Connecting-IP": "192.0.2.123" },
        }),
        limited,
        createExecutionContext(),
      );
      expect(response.status).toBe(429);
      expect(response.headers.get("Retry-After")).toBe("60");
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
    expect(keys[0]).toMatch(/^http:[a-f0-9]{64}$/);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).not.toContain("192.0.2.123");
  });

  test("a failed limiter blocks requests without exposing its error", async () => {
    const unavailable: Env = {
      ...bindings,
      AGENTPOST_REQUEST_LIMITER: {
        limit: async () => {
          throw new Error("private provider detail");
        },
      },
    };
    const response = await worker.fetch(
      new Request("https://mail.test/v1/inboxes"),
      unavailable,
      createExecutionContext(),
    );
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private provider detail");
  });
});

describe("send admission", () => {
  test("a shared inbox limit blocks new sends while idempotent retries remain readable", async () => {
    const inbox = await createInbox();
    const keys: string[] = [];
    let allow = true;
    const limited: Env = {
      ...bindings,
      AGENTPOST_SEND_LIMITER: {
        limit: async ({ key }) => {
          keys.push(key);
          return { success: allow };
        },
      },
    };
    const send = (key: string, token: string) =>
      app.request(
        `https://mail.test/v1/inboxes/${inbox.id}/send`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "Idempotency-Key": key,
          },
          body: JSON.stringify({ to: ["test@example.net"], subject: "Test", text: "Body" }),
        },
        limited,
      );
    const first = await send("same", inbox.token);
    expect(first.status).toBe(202);
    const original = await first.json<{ id: string }>();
    allow = false;
    const retry = await send("same", inbox.token);
    expect(retry.status).toBe(202);
    expect((await retry.json<{ id: string }>()).id).toBe(original.id);
    for (const token of [inbox.token, admin]) {
      const rejected = await send("new", token);
      expect(rejected.status).toBe(429);
      expect(rejected.headers.get("Retry-After")).toBe("60");
    }
    expect(keys).toEqual(Array(3).fill(`send:${inbox.id}`));
    expect((await bindings.DB.prepare("SELECT count(*) AS total FROM outbox").first())?.total).toBe(
      1,
    );
  });

  test("no send is persisted when the send limiter is unavailable", async () => {
    const inbox = await createInbox();
    const response = await app.request(
      `https://mail.test/v1/inboxes/${inbox.id}/send`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${inbox.token}`,
          "Content-Type": "application/json",
          "Idempotency-Key": "not-admitted",
        },
        body: JSON.stringify({ to: ["test@example.net"], subject: "Test", text: "Body" }),
      },
      {
        ...bindings,
        AGENTPOST_SEND_LIMITER: {
          limit: async () => {
            throw new Error("offline");
          },
        },
      },
    );
    expect(response.status).toBe(503);
    expect((await bindings.DB.prepare("SELECT count(*) AS total FROM outbox").first())?.total).toBe(
      0,
    );
  });

  test("rejects control characters and misleading JSON content types without creating sends", async () => {
    const inbox = await createInbox();
    for (const [subject, contentType, status] of [
      ["Hello\u0000Bcc: victim@example.net", "application/json", 400],
      ["Hello\u007f", "application/json", 400],
      ["Hello\u0085Injected", "application/json", 400],
      ["Hello", "application/json-evil", 415],
      ["Hello", "application/jsonp", 415],
    ] as const) {
      const response = await app.request(
        `https://mail.test/v1/inboxes/${inbox.id}/send`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${inbox.token}`,
            "Content-Type": contentType,
            "Idempotency-Key": "bad-input",
          },
          body: JSON.stringify({ to: ["test@example.net"], subject, text: "Body" }),
        },
        bindings,
      );
      expect(response.status).toBe(status);
    }
    expect((await bindings.DB.prepare("SELECT count(*) AS total FROM outbox").first())?.total).toBe(
      0,
    );
  });
});

test("foreign message, raw, attachment and outbox IDs never bypass inbox scope", async () => {
  const own = await createInbox();
  const foreign = await createInbox();
  const messageId = "b".repeat(64);
  await bindings.DB.prepare(
    "INSERT INTO messages (id, inbox_id, raw_key, envelope_from, envelope_to, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(
      messageId,
      foreign.id,
      "raw/foreign.eml",
      "sender@example.net",
      "foreign@example.com",
      Date.now(),
    )
    .run();
  await bindings.MAIL.put("raw/foreign.eml", "private foreign mail");
  const sending = await app.request(
    `https://mail.test/v1/inboxes/${foreign.id}/send`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${foreign.token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "foreign-send",
      },
      body: JSON.stringify({
        to: ["test@example.net"],
        subject: "Private",
        text: "private foreign send",
      }),
    },
    bindings,
  );
  expect(sending.status).toBe(202);
  const outbox = await sending.json<{ id: string }>();
  for (const [method, path] of [
    ["GET", `/v1/inboxes/${foreign.id}`],
    ["GET", `/v1/inboxes/${foreign.id}/outbox/${outbox.id}`],
    ["POST", `/v1/inboxes/${foreign.id}/token`],
    ["GET", `/v1/inboxes/${own.id}/messages/${messageId}`],
    ["GET", `/v1/inboxes/${own.id}/messages/${messageId}/raw`],
    ["GET", `/v1/inboxes/${own.id}/messages/${messageId}/attachments/0`],
    ["POST", `/v1/inboxes/${own.id}/messages/${messageId}/reprocess`],
    ["POST", `/v1/inboxes/${own.id}/messages/${messageId}/reply`],
    ["GET", `/v1/inboxes/${own.id}/outbox/${outbox.id}`],
  ]) {
    const response = await app.request(
      `https://mail.test${path}`,
      {
        method,
        headers: { Authorization: `Bearer ${own.token}` },
      },
      bindings,
    );
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("private foreign");
  }
  expect((await bindings.DB.prepare("SELECT count(*) AS total FROM outbox").first())?.total).toBe(
    1,
  );
});
