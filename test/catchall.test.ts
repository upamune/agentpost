import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, expect, test, vi } from "vitest";
import app from "../src/api";
import { MAX_MAIL_BYTES } from "../src/common";
import { parseMessage, receive, repairRawIndex } from "../src/inbound";
import type { Env, Message } from "../src/types";

const admin = "test-admin-token-with-at-least-32-characters";
const bindings: Env = env;
type Catchall = {
  configured: boolean;
  created?: boolean;
  token?: string;
  inbox?: { id: string; address: string; active: number };
  forwarding?: { mode: string };
};

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

function request(
  path: string,
  method = "GET",
  body?: unknown,
  token = admin,
  overrides: Partial<Env> = {},
) {
  return app.request(
    `https://mail.test/v1${path}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    { ...bindings, ...overrides },
  );
}

async function provision(overrides: Partial<Env> = {}) {
  const response = await request("/catchall", "POST", undefined, admin, overrides);
  return { status: response.status, body: await response.json<Catchall>() };
}

async function namedInbox(localPart: string) {
  const response = await request("/inboxes", "POST", { local_part: localPart });
  expect(response.status).toBe(201);
  return response.json<{ id: string; address: string; token: string }>();
}

const mime = (to: string) =>
  `From: Shop <orders@shop.example>\r\nTo: ${to}\r\nSubject: Order confirmation\r\nMessage-ID: <order-1@shop.example>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nThank you for your order.\r\n`;

function email(to: string, raw = mime(to), rawSize = new TextEncoder().encode(raw).byteLength) {
  return {
    from: "orders@shop.example",
    to,
    headers: new Headers(),
    raw: new Response(raw).body!,
    rawSize,
    canBeForwarded: true,
    setReject: vi.fn(),
    forward: vi.fn(async () => ({ messageId: "unexpected-forward" })),
    reply: vi.fn(async () => ({ messageId: "unexpected-reply" })),
  };
}

async function messages(inboxId: string) {
  return (
    await env.DB.prepare("SELECT * FROM messages WHERE inbox_id = ? ORDER BY envelope_to")
      .bind(inboxId)
      .all<Message>()
  ).results;
}

test("catch-all provisioning is admin-only, idempotent and forces forwarding off", async () => {
  expect(await (await request("/catchall")).json()).toEqual({ configured: false });
  const first = await provision();
  expect(first.status).toBe(201);
  expect(first.body).toMatchObject({
    configured: true,
    created: true,
    inbox: { address: "_catchall@example.com", active: 1 },
    forwarding: { mode: "off" },
  });
  expect(first.body.token).toMatch(/^[A-Za-z0-9_-]{32,}$/);
  const id = first.body.inbox!.id;
  expect(
    await env.DB.prepare("SELECT value FROM maintenance WHERE key = 'catchall_inbox_id'").first(),
  ).toEqual({ value: id });
  expect(
    await env.DB.prepare("SELECT token_hash FROM inboxes WHERE id = ?").bind(id).first(),
  ).toMatchObject({ token_hash: expect.stringMatching(/^[a-f0-9]{64}$/) });

  const second = await provision();
  expect(second.status).toBe(200);
  expect(second.body).toMatchObject({ created: false, inbox: { id }, forwarding: { mode: "off" } });
  expect(second.body.token).toBeUndefined();
  expect(await (await request("/catchall")).json()).toMatchObject({
    configured: true,
    inbox: { id },
  });
  expect((await env.DB.prepare("SELECT count(*) AS count FROM inboxes").first())?.count).toBe(1);

  // Its token reads the quarantine like any inbox token, but cannot administer the catch-all.
  expect((await request(`/inboxes/${id}`, "GET", undefined, first.body.token)).status).toBe(200);
  expect((await request("/catchall", "POST", undefined, first.body.token)).status).toBe(403);
  expect((await request("/catchall", "GET", undefined, first.body.token)).status).toBe(403);
});

test("concurrent catch-all provisioning records exactly one inbox", async () => {
  const results = await Promise.all([provision(), provision(), provision()]);
  const ids = new Set(results.map((result) => result.body.inbox?.id));
  expect(ids.size).toBe(1);
  expect(results.filter((result) => result.body.created)).toHaveLength(1);
  expect((await env.DB.prepare("SELECT count(*) AS count FROM inboxes").first())?.count).toBe(1);
});

test("catch-all provisioning re-asserts forwarding off after an override", async () => {
  const { body } = await provision();
  await env.DB.prepare(
    "UPDATE inbox_forwarding SET mode = 'custom', destination = 'owner@example.net' WHERE inbox_id = ?",
  )
    .bind(body.inbox!.id)
    .run();
  expect((await provision()).body.forwarding).toEqual({ mode: "off" });
  expect(
    await env.DB.prepare("SELECT mode, destination FROM inbox_forwarding WHERE inbox_id = ?")
      .bind(body.inbox!.id)
      .first(),
  ).toEqual({ mode: "off", destination: null });
});

test("catch-all local part is configurable and validated", async () => {
  const custom = await provision({ AGENTPOST_CATCHALL_LOCAL_PART: "Unknown.Mail" });
  expect(custom.body.inbox?.address).toBe("unknown.mail@example.com");
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const invalid = await provision({ AGENTPOST_CATCHALL_LOCAL_PART: "not valid@x" });
  expect(invalid.status).toBe(503);
  expect((await env.DB.prepare("SELECT count(*) AS count FROM inboxes").first())?.count).toBe(0);
});

test("catch-all provisioning never adopts an existing inbox with the same address", async () => {
  const existing = await namedInbox("_catchall");
  const result = await provision();
  expect(result.status).toBe(409);
  expect(
    await env.DB.prepare("SELECT value FROM maintenance WHERE key = 'catchall_inbox_id'").first(),
  ).toBeNull();
  expect(
    await env.DB.prepare("SELECT count(*) AS count FROM inbox_forwarding WHERE inbox_id = ?")
      .bind(existing.id)
      .first(),
  ).toEqual({ count: 0 });
});

test("unknown recipients are retained in the catch-all with their original envelope recipient", async () => {
  const { body } = await provision();
  const catchall = body.inbox!;
  const incoming = email("Prio@Example.com");
  await receive(incoming, bindings);
  expect(incoming.setReject).not.toHaveBeenCalled();
  const [message] = await messages(catchall.id);
  expect(message).toMatchObject({ envelope_to: "Prio@Example.com", status: "pending" });
  const object = await env.MAIL.head(message!.raw_key);
  expect(message!.raw_key).toBe(`raw/${catchall.id}/${message!.id}.eml`);
  expect(object?.customMetadata).toMatchObject({
    inbox_id: catchall.id,
    envelope_to: "Prio@Example.com",
    forward_status: "skipped",
    forward_destination: "",
  });

  await parseMessage(bindings, message!.id);
  for (const token of [admin, body.token!]) {
    const list = await request(`/inboxes/${catchall.id}/messages`, "GET", undefined, token);
    expect(list.status).toBe(200);
    expect((await list.json<{ items: { id: string }[] }>()).items.map((item) => item.id)).toEqual([
      message!.id,
    ]);
    const read = await request(
      `/inboxes/${catchall.id}/messages/${message!.id}`,
      "GET",
      undefined,
      token,
    );
    expect(await read.json()).toMatchObject({
      envelope_to: "Prio@Example.com",
      subject: "Order confirmation",
      content: { text: expect.stringContaining("Thank you for your order.") },
    });
  }
});

test("identical MIME for several unknown recipients keeps one message per recipient", async () => {
  const { body } = await provision();
  const raw = mime("undisclosed-recipients:;");
  await receive(email("first@example.com", raw), bindings);
  await receive(email("second@example.com", raw), bindings);
  // A retried SMTP delivery of the same recipient stays deduplicated.
  await receive(email("first@example.com", raw), bindings);
  expect((await messages(body.inbox!.id)).map((message) => message.envelope_to)).toEqual([
    "first@example.com",
    "second@example.com",
  ]);
  // Raw-first recovery restores the catch-all index from R2 metadata alone.
  await env.DB.prepare("DELETE FROM forwarding_deliveries").run();
  await env.DB.prepare("DELETE FROM messages").run();
  await repairRawIndex(bindings);
  expect((await messages(body.inbox!.id)).map((message) => message.envelope_to)).toEqual([
    "first@example.com",
    "second@example.com",
  ]);
});

test("issued inboxes keep receiving their own mail when a catch-all exists", async () => {
  const { body } = await provision();
  const box = await namedInbox("orders");
  const incoming = email(box.address);
  await receive(incoming, bindings);
  expect(incoming.setReject).not.toHaveBeenCalled();
  expect((await messages(box.id)).map((message) => message.envelope_to)).toEqual([box.address]);
  expect(await messages(body.inbox!.id)).toEqual([]);
});

test("disabled inboxes still reject when a catch-all exists", async () => {
  const { body } = await provision();
  const box = await namedInbox("retired");
  expect((await request(`/inboxes/${box.id}`, "PATCH", { active: false })).status).toBe(200);
  const incoming = email(box.address.toUpperCase());
  await receive(incoming, bindings);
  expect(incoming.setReject).toHaveBeenCalledWith("Unknown or disabled recipient");
  expect(await messages(body.inbox!.id)).toEqual([]);
  expect((await env.MAIL.list()).objects).toHaveLength(0);
});

test("unknown recipients still reject when no catch-all is provisioned", async () => {
  const incoming = email("prio@example.com");
  await receive(incoming, bindings);
  expect(incoming.setReject).toHaveBeenCalledWith("Unknown or disabled recipient");
  expect((await env.MAIL.list()).objects).toHaveLength(0);
});

test("a disabled catch-all inbox turns catch-all delivery off", async () => {
  const { body } = await provision();
  expect((await request(`/inboxes/${body.inbox!.id}`, "PATCH", { active: false })).status).toBe(
    200,
  );
  const incoming = email("prio@example.com");
  await receive(incoming, bindings);
  expect(incoming.setReject).toHaveBeenCalledWith("Unknown or disabled recipient");
  expect((await env.MAIL.list()).objects).toHaveLength(0);
});

test("recipients outside the configured domain are not caught", async () => {
  await provision();
  const incoming = email("prio@other.example");
  await receive(incoming, bindings);
  expect(incoming.setReject).toHaveBeenCalledWith("Unknown or disabled recipient");
  expect((await env.MAIL.list()).objects).toHaveLength(0);
});

test("the 10 MiB limit applies to catch-all delivery", async () => {
  await provision();
  const incoming = email("prio@example.com", mime("prio@example.com"), MAX_MAIL_BYTES + 1);
  await receive(incoming, bindings);
  expect(incoming.setReject).toHaveBeenCalledWith("Message exceeds 10 MiB limit");
  expect((await env.MAIL.list()).objects).toHaveLength(0);
  expect((await env.DB.prepare("SELECT count(*) AS count FROM messages").first())?.count).toBe(0);
});

const forwardTarget = "owner@example.net";
const forwardingEnv = { AGENTPOST_FORWARD_ALLOWED_DESTINATIONS: JSON.stringify([forwardTarget]) };

async function forwardingRows(inboxId: string) {
  return (
    await env.DB.prepare(
      "SELECT message_id, destination, status, error FROM forwarding_deliveries WHERE inbox_id = ?",
    )
      .bind(inboxId)
      .all<{
        message_id: string;
        destination: string | null;
        status: string;
        error: string | null;
      }>()
  ).results;
}

test("catch-all delivery never forwards unknown mail, even with global and inbox destinations", async () => {
  const configured = { ...bindings, ...forwardingEnv };
  const put = async (path: string, body: unknown) =>
    (await request(path, "PUT", body, admin, forwardingEnv)).status;
  expect(await put("/forwarding", { destination: forwardTarget })).toBe(200);
  const issued = await namedInbox("orders");
  const { body } = await provision(forwardingEnv);
  const catchall = body.inbox!;
  // Even an administrator override on the catch-all inbox cannot forward unknown recipients.
  expect(
    await put(`/inboxes/${catchall.id}/forwarding`, { mode: "custom", destination: forwardTarget }),
  ).toBe(200);

  const unknown = email("prio@example.com");
  await receive(unknown, configured);
  expect(unknown.setReject).not.toHaveBeenCalled();
  expect(unknown.forward).not.toHaveBeenCalled();
  const [row] = await forwardingRows(catchall.id);
  expect(row).toMatchObject({ status: "skipped", destination: null, error: null });
  expect(
    (await env.MAIL.head(`raw/${catchall.id}/${row!.message_id}.eml`))?.customMetadata,
  ).toMatchObject({
    envelope_to: "prio@example.com",
    forward_status: "skipped",
    forward_destination: "",
  });

  // Issued inboxes keep inheriting the global destination.
  const known = email(issued.address);
  await receive(known, configured);
  expect(known.forward).toHaveBeenCalledWith(forwardTarget, expect.any(Headers));
});

test("a disabled recipient is rejected rather than caught or forwarded when a catch-all exists", async () => {
  const configured = { ...bindings, ...forwardingEnv };
  expect(
    (await request("/forwarding", "PUT", { destination: forwardTarget }, admin, forwardingEnv))
      .status,
  ).toBe(200);
  const { body } = await provision(forwardingEnv);
  const box = await namedInbox("retired");
  await request(`/inboxes/${box.id}`, "PATCH", { active: false });
  const incoming = email(box.address);
  await receive(incoming, configured);
  expect(incoming.setReject).toHaveBeenCalledWith("Unknown or disabled recipient");
  expect(incoming.forward).not.toHaveBeenCalled();
  expect(await forwardingRows(box.id)).toEqual([]);
  expect(await forwardingRows(body.inbox!.id)).toEqual([]);
});
