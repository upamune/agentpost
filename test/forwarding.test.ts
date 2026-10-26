import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import app from "../src/api";
import { receive, parseMessage, repairRawIndex } from "../src/inbound";
import { recoverForwarding } from "../src/forwarding";
import type { Env } from "../src/types";

const admin = "test-admin-token-with-at-least-32-characters";
const primary = "owner@example.net",
  alternate = "other@example.org";
const bindings: Env = {
  ...env,
  AGENTPOST_FORWARD_ALLOWED_DESTINATIONS: JSON.stringify([primary, alternate]),
};
type Box = { id: string; address: string; token: string };
type Forward = {
  message_id: string;
  status: string;
  destination: string | null;
  error: string | null;
};

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
afterEach(() => vi.restoreAllMocks());

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
async function box(): Promise<Box> {
  return (await request("/inboxes", "POST", { label: "site.example" })).json();
}
async function global(destination: string | null = primary) {
  const response = await request("/forwarding", "PUT", { destination });
  expect(response.status).toBe(200);
}
async function override(inbox: Box, mode: "inherit" | "off" | "custom", destination?: string) {
  const response = await request(`/inboxes/${inbox.id}/forwarding`, "PUT", {
    mode,
    ...(destination ? { destination } : {}),
  });
  expect(response.status).toBe(200);
}
function incoming(
  inbox: Box,
  forward = vi.fn(async (_destination: string, _headers?: Headers) => {}),
  headers = new Headers(),
) {
  const raw = `From: sender@example.org\r\nTo: ${inbox.address}\r\nSubject: Account confirmation\r\nContent-Type: text/plain\r\n\r\nPrivate confirmation`;
  return {
    from: "sender@example.org",
    to: inbox.address,
    rawSize: raw.length,
    raw: new Response(raw).body!,
    headers,
    canBeForwarded: true,
    forward: vi.fn(async (destination: string, extra?: Headers) => {
      await forward(destination, extra);
      return { messageId: "native-forward-test" };
    }),
    reply: async () => ({ messageId: "native-reply-test" }),
    setReject: vi.fn(),
  };
}
async function outcomes(inbox: Box): Promise<Forward[]> {
  return (await request(`/inboxes/${inbox.id}/forwarding/deliveries`))
    .json<{ deliveries: Forward[] }>()
    .then((value) => value.deliveries);
}

test("global defaults, custom overrides, explicit off and restored inheritance are independent", async () => {
  const a = await box(),
    b = await box(),
    c = await box();
  expect(await (await request("/forwarding")).json()).toMatchObject({ destination: null });
  await global();
  await override(b, "custom", alternate);
  await override(c, "off");
  expect(await (await request(`/inboxes/${a.id}/forwarding`)).json()).toMatchObject({
    mode: "inherit",
    effective_destination: primary,
  });
  expect(await (await request(`/inboxes/${b.id}/forwarding`)).json()).toMatchObject({
    mode: "custom",
    effective_destination: alternate,
  });
  expect(await (await request(`/inboxes/${c.id}/forwarding`)).json()).toMatchObject({
    mode: "off",
    effective_destination: null,
  });
  await global(null);
  expect(await (await request(`/inboxes/${b.id}/forwarding`)).json()).toMatchObject({
    effective_destination: alternate,
  });
  await override(b, "inherit");
  expect(await (await request(`/inboxes/${b.id}/forwarding`)).json()).toMatchObject({
    mode: "inherit",
    effective_destination: null,
  });
});

test("configuration and destination history are administrator-only even for the inbox token", async () => {
  const inbox = await box();
  for (const path of [
    "/forwarding",
    `/inboxes/${inbox.id}/forwarding`,
    `/inboxes/${inbox.id}/forwarding/deliveries`,
  ])
    expect((await request(path, "GET", undefined, inbox.token)).status).toBe(403);
  expect((await request("/forwarding", "PUT", { destination: primary }, inbox.token)).status).toBe(
    403,
  );
  expect(
    (
      await request(
        `/inboxes/${inbox.id}/forwarding`,
        "PUT",
        { mode: "custom", destination: primary },
        inbox.token,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await request(
        `/inboxes/${inbox.id}/forwarding/deliveries/${"a".repeat(64)}/resolve`,
        "POST",
        { note: "checked" },
        inbox.token,
      )
    ).status,
  ).toBe(403);
});

test("destinations reject open relay targets, same-domain loops, malformed policy and input", async () => {
  for (const destination of [
    "stranger@example.net",
    "name@example.com",
    "name@sub.example.com",
    "x\r\nBcc:y@example.net",
    "",
    "name@example.net,other@example.org",
  ])
    expect((await request("/forwarding", "PUT", { destination })).status).toBe(400);
  const inbox = await box();
  for (const body of [
    { mode: "custom" },
    { mode: "off", destination: primary },
    { mode: "inherit", destination: primary },
    { mode: "unknown" },
  ])
    expect((await request(`/inboxes/${inbox.id}/forwarding`, "PUT", body)).status).toBe(400);
  expect(
    (
      await request("/forwarding", "PUT", { destination: primary }, admin, {
        AGENTPOST_FORWARD_ALLOWED_DESTINATIONS: "broken",
      })
    ).status,
  ).toBe(503);
  expect(
    (
      await request("/forwarding", "PUT", { destination: primary }, admin, {
        AGENTPOST_FORWARD_ALLOWED_DESTINATIONS: undefined,
      })
    ).status,
  ).toBe(400);
  expect((await request("/forwarding", "PUT", { destination: "owner@EXAMPLE.NET" })).status).toBe(
    200,
  );
});

test("native forwarding starts only after durable MIME, indexing and a conditional claim", async () => {
  const inbox = await box();
  await global();
  const forward = vi.fn(async (destination: string, headers?: Headers) => {
    expect(destination).toBe(primary);
    expect(headers?.get("X-Agentpost-Forwarded")).toBe("1");
    const row = await env.DB.prepare("SELECT raw_key FROM messages WHERE inbox_id = ?")
      .bind(inbox.id)
      .first<{ raw_key: string }>();
    expect(await (await env.MAIL.get(row!.raw_key))!.text()).toContain("Private confirmation");
    expect((await outcomes(inbox))[0]?.status).toBe("sending");
  });
  await receive(incoming(inbox, forward), bindings);
  expect(forward).toHaveBeenCalledTimes(1);
  expect((await outcomes(inbox))[0]).toMatchObject({ status: "accepted", destination: primary });
  const id = (await outcomes(inbox))[0]!.message_id;
  await parseMessage(bindings, id);
  expect(
    (await env.DB.prepare("SELECT status FROM messages WHERE id = ?").bind(id).first())?.status,
  ).toBe("ready");
});

test("explicit off skips forwarding while other inboxes use the default or their custom destination", async () => {
  const a = await box(),
    b = await box(),
    c = await box();
  await global();
  await override(b, "custom", alternate);
  await override(c, "off");
  const forward = vi.fn(async (_destination: string, _headers?: Headers) => {});
  for (const inbox of [a, b, c]) await receive(incoming(inbox, forward), bindings);
  expect(forward.mock.calls.map((call) => call[0])).toEqual([primary, alternate]);
  expect((await outcomes(c))[0]?.status).toBe("skipped");
});

test("duplicate SMTP delivery never forwards twice or adopts a changed destination", async () => {
  const inbox = await box();
  await global();
  const forward = vi.fn(async (_destination: string, _headers?: Headers) => {});
  await receive(incoming(inbox, forward), bindings);
  await global(alternate);
  await receive(incoming(inbox, forward), bindings);
  expect(forward).toHaveBeenCalledTimes(1);
  expect(await outcomes(inbox)).toHaveLength(1);
  expect((await outcomes(inbox))[0]?.destination).toBe(primary);
});

test("enabling a default never replays an earlier skipped message", async () => {
  const inbox = await box();
  const forward = vi.fn(async (_destination: string, _headers?: Headers) => {});
  await receive(incoming(inbox, forward), bindings);
  await global();
  await receive(incoming(inbox, forward), bindings);
  expect(forward).not.toHaveBeenCalled();
  expect((await outcomes(inbox))[0]?.status).toBe("skipped");
});

test("simultaneous duplicates share one native attempt", async () => {
  const inbox = await box();
  await global();
  const forward = vi.fn(async (_destination: string, _headers?: Headers) => {});
  await Promise.all([
    receive(incoming(inbox, forward), bindings),
    receive(incoming(inbox, forward), bindings),
  ]);
  expect(forward).toHaveBeenCalledTimes(1);
  expect(await outcomes(inbox)).toHaveLength(1);
});

test("a native exception retains mail, reports unknown and cannot cause an automatic resend", async () => {
  const inbox = await box();
  await global();
  const forward = vi.fn(async (_destination: string, _headers?: Headers) => {
    throw new Error("Uncertain acceptance: private operator address");
  });
  await receive(incoming(inbox, forward), bindings);
  await receive(incoming(inbox, forward), bindings);
  await recoverForwarding(bindings);
  expect(forward).toHaveBeenCalledTimes(1);
  const row = (await outcomes(inbox))[0]!;
  expect(row.status).toBe("unknown");
  expect(JSON.stringify(row)).not.toContain("private operator address");
  expect(await (await request("/health")).json()).toMatchObject({ unknown_forwarding: 1 });
  await parseMessage(bindings, row.message_id);
  expect(
    (
      await request(
        `/inboxes/${inbox.id}/forwarding/deliveries/${row.message_id}/resolve`,
        "POST",
        { note: "Provider activity inspected; original retained" },
      )
    ).status,
  ).toBe(200);
  expect(await (await request("/health")).json()).toMatchObject({ unknown_forwarding: 0 });
  expect((await outcomes(inbox))[0]?.status).toBe("unknown");
});

test("loop markers and a withdrawn allowlist block disclosure without losing original mail", async () => {
  const inbox = await box();
  await global();
  const forward = vi.fn(async (_destination: string, _headers?: Headers) => {});
  await receive(incoming(inbox, forward, new Headers({ "X-Agentpost-Forwarded": "1" })), bindings);
  expect(forward).not.toHaveBeenCalled();
  expect((await outcomes(inbox))[0]).toMatchObject({
    status: "blocked",
    error: "forwarding_loop_marker",
  });
  const second = await box();
  await receive(incoming(second, forward), {
    ...bindings,
    AGENTPOST_FORWARD_ALLOWED_DESTINATIONS: "[]",
  });
  expect(forward).not.toHaveBeenCalled();
  expect((await outcomes(second))[0]).toMatchObject({
    status: "blocked",
    error: "destination_policy_rejected",
  });
});

test("raw-storage failure prevents forwarding", async () => {
  const inbox = await box();
  await global();
  const message = incoming(inbox);
  vi.spyOn(env.MAIL, "put").mockRejectedValueOnce(new Error("Storage unavailable"));
  await expect(receive(message, bindings)).rejects.toThrow("Storage unavailable");
  expect(message.forward).not.toHaveBeenCalled();
  expect(await outcomes(inbox)).toEqual([]);
});

test("raw-index repair restores forwarding intent but never performs a native forward", async () => {
  const inbox = await box();
  await global();
  const message = incoming(inbox);
  const prepare = env.DB.prepare.bind(env.DB);
  vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
    if (sql.includes("INSERT OR IGNORE INTO messages")) throw new Error("Index unavailable");
    return prepare(sql);
  });
  await expect(receive(message, bindings)).rejects.toThrow("Index unavailable");
  expect(message.forward).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  await repairRawIndex(bindings);
  const row = (await outcomes(inbox))[0]!;
  expect(row.status).toBe("pending");
  await env.DB.prepare("UPDATE forwarding_deliveries SET updated_at = ? WHERE message_id = ?")
    .bind(Date.now() - 180_000, row.message_id)
    .run();
  await recoverForwarding(bindings);
  expect((await outcomes(inbox))[0]).toMatchObject({ status: "blocked" });
  expect(message.forward).not.toHaveBeenCalled();
});

test("stale recovery and late completion preserve unknown without repeating a native call", async () => {
  const inbox = await box();
  await global();
  let entered!: () => void, finish!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const forward = vi.fn(async (_destination: string, _headers?: Headers) => {
    entered();
    await pending;
  });
  const receiving = receive(incoming(inbox, forward), bindings);
  await ready;
  const row = (await outcomes(inbox))[0]!;
  await env.DB.prepare("UPDATE forwarding_deliveries SET updated_at = ? WHERE message_id = ?")
    .bind(Date.now() - 180_000, row.message_id)
    .run();
  await recoverForwarding(bindings);
  expect((await outcomes(inbox))[0]?.status).toBe("unknown");
  await receive(incoming(inbox, forward), bindings);
  finish();
  await receiving;
  expect(forward).toHaveBeenCalledTimes(1);
  expect((await outcomes(inbox))[0]?.status).toBe("unknown");
});

test("racing first receipts preserve the winning raw snapshot across a global-setting change", async () => {
  const inbox = await box();
  await global();
  const put = env.MAIL.put.bind(env.MAIL);
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pause = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  vi.spyOn(env.MAIL, "put").mockImplementation(async (key, value, options) => {
    if (key.startsWith("raw/") && first) {
      first = false;
      entered();
      await pause;
    }
    return put(key, value, options);
  });
  const forward = vi.fn(async (_destination: string, _headers?: Headers) => {});
  const receiving = receive(incoming(inbox, forward), bindings);
  await ready;
  await global(alternate);
  await receive(incoming(inbox, forward), bindings);
  release();
  await receiving;
  expect(forward).toHaveBeenCalledTimes(1);
  expect(forward.mock.calls[0]?.[0]).toBe(alternate);
  const row = (await outcomes(inbox))[0]!;
  expect(row.destination).toBe(alternate);
  expect(
    (await env.MAIL.head(`raw/${inbox.id}/${row.message_id}.eml`))?.customMetadata
      ?.forward_destination,
  ).toBe(alternate);
});

test("a disabled recipient cannot admit a native forward", async () => {
  const inbox = await box();
  await global();
  await request(`/inboxes/${inbox.id}`, "PATCH", { active: false });
  const message = incoming(inbox);
  await receive(message, bindings);
  expect(message.setReject).toHaveBeenCalledWith("Unknown or disabled recipient");
  expect(message.forward).not.toHaveBeenCalled();
  expect(await outcomes(inbox)).toEqual([]);
});

test("disabling after retention but before the native claim prevents forwarding", async () => {
  const inbox = await box();
  await global();
  const message = incoming(inbox);
  const jobs: Env["JOBS"] = {
    ...bindings.JOBS,
    send: async (job, options) => {
      expect((await request(`/inboxes/${inbox.id}`, "PATCH", { active: false })).status).toBe(200);
      return bindings.JOBS.send(job, options);
    },
  };
  await receive(message, { ...bindings, JOBS: jobs });
  expect(message.forward).not.toHaveBeenCalled();
  expect((await outcomes(inbox))[0]).toMatchObject({
    status: "blocked",
    error: "inbox_disabled_before_claim",
  });
});
