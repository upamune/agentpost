import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, expect, test } from "vitest";
import app from "../src/api";
import { stringifyBoundedJson } from "../src/bounded-json";
import { parseMessage, receive } from "../src/inbound";
import type { Env } from "../src/types";

const bindings: Env = env;
const admin = "test-admin-token-with-at-least-32-characters";

beforeEach(async () => {
  await reset();
  await applyD1Migrations(bindings.DB, env.TEST_MIGRATIONS);
});

async function inbox() {
  const response = await app.request(
    "https://mail.test/v1/inboxes",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${admin}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    },
    bindings,
  );
  expect(response.status).toBe(201);
  return response.json<{ id: string; address: string; token: string }>();
}

function incoming(to: string, raw: ReadableStream<Uint8Array>, rawSize: number) {
  const rejected: string[] = [];
  return {
    input: {
      from: "attacker@example.net",
      to,
      headers: new Headers(),
      raw,
      rawSize,
      canBeForwarded: true,
      setReject: (reason: string) => rejected.push(reason),
      forward() {
        throw new Error("Forward not expected");
      },
      reply() {
        throw new Error("Automatic reply not expected");
      },
    },
    rejected,
  };
}

test("inbound retention contract: an admission already in progress can finish after disable", async () => {
  const box = await inbox();
  const bytes = new TextEncoder().encode("Subject: In flight\r\n\r\nUntrusted body\r\n");
  let release: ReadableStreamDefaultController<Uint8Array> | undefined;
  let signalRead: () => void = () => {};
  const reading = new Promise<void>((resolve) => {
    signalRead = resolve;
  });
  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        release = controller;
      },
      pull() {
        signalRead();
      },
    },
    { highWaterMark: 0 },
  );
  const delivery = incoming(box.address, stream, bytes.byteLength);
  const receiving = receive(delivery.input, bindings);
  await reading;
  try {
    const disabled = await app.request(
      `https://mail.test/v1/inboxes/${box.id}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${admin}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ active: false }),
      },
      bindings,
    );
    expect(disabled.status).toBe(200);
    expect(
      (await bindings.DB.prepare("SELECT active FROM inboxes WHERE id = ?").bind(box.id).first())
        ?.active,
    ).toBe(0);
  } finally {
    release?.enqueue(bytes);
    release?.close();
    await receiving;
  }
  expect(delivery.rejected).toEqual([]);
  expect(
    (
      await bindings.DB.prepare("SELECT count(*) AS count FROM messages WHERE inbox_id = ?")
        .bind(box.id)
        .first()
    )?.count,
  ).toBe(1);
  expect((await bindings.MAIL.list({ prefix: `raw/${box.id}/` })).objects).toHaveLength(1);
});

test("audit boundary: a new inbound admission after disable is rejected without storing MIME", async () => {
  const box = await inbox();
  const disabled = await app.request(
    `https://mail.test/v1/inboxes/${box.id}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${admin}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ active: false }),
    },
    bindings,
  );
  expect(disabled.status).toBe(200);
  const delivery = incoming(box.address, new Blob(["Subject: Later\r\n\r\nBody"]).stream(), 24);
  await receive(delivery.input, bindings);
  expect(delivery.rejected).toEqual(["Unknown or disabled recipient"]);
  expect((await bindings.MAIL.list({ prefix: `raw/${box.id}/` })).objects).toHaveLength(0);
});

test("audit measurement: a bounded raw MIME can expand sixfold in the parsed JSON document", async () => {
  const box = await inbox();
  const raw = "Content-Type: text/plain\r\n\r\n" + "\u0000".repeat(1024 * 1024);
  const bytes = new TextEncoder().encode(raw);
  const delivery = incoming(box.address, new Blob([bytes]).stream(), bytes.byteLength);
  await receive(delivery.input, bindings);
  const row = await bindings.DB.prepare("SELECT id FROM messages WHERE inbox_id = ?")
    .bind(box.id)
    .first<{ id: string }>();
  expect(row).not.toBeNull();
  await parseMessage(bindings, row!.id);
  const parsed = await bindings.MAIL.get(`parsed/${row!.id}.json`);
  expect(parsed).not.toBeNull();
  expect(parsed!.size).toBeGreaterThan(5.9 * bytes.byteLength);
  expect((await parsed!.json<{ text: string }>()).text.length).toBeGreaterThanOrEqual(1024 * 1024);
});

test("parsed JSON exceeding 16 MiB retains raw MIME without ready state or notification", async () => {
  const box = await inbox();
  const bytes = new TextEncoder().encode(
    "Content-Type: text/plain\r\n\r\n" + "\u0000".repeat(3 * 1024 * 1024),
  );
  const delivery = incoming(box.address, new Blob([bytes]).stream(), bytes.byteLength);
  await receive(delivery.input, bindings);
  const row = await bindings.DB.prepare("SELECT id, raw_key FROM messages WHERE inbox_id = ?")
    .bind(box.id)
    .first<{ id: string; raw_key: string }>();
  expect(row).not.toBeNull();
  await expect(parseMessage(bindings, row!.id)).rejects.toThrow(
    "Parsed message exceeds JSON size limit",
  );
  expect(await bindings.MAIL.head(row!.raw_key)).not.toBeNull();
  expect(await bindings.MAIL.head(`parsed/${row!.id}.json`)).toBeNull();
  expect(
    (await bindings.DB.prepare("SELECT status FROM messages WHERE id = ?").bind(row!.id).first())
      ?.status,
  ).toBe("pending");
  expect(
    (
      await bindings.DB.prepare("SELECT count(*) AS count FROM events WHERE inbox_id = ?")
        .bind(box.id)
        .first()
    )?.count,
  ).toBe(0);
});

test("JSON preflight matches actual UTF-8 size at the exact limit", () => {
  const value = {
    omitted: undefined,
    text: 'ASCII é 日 😀 " \\ \b \t \n \f \r \u0000 \u001f \ud800 \udfff',
    array: [undefined, null, false, true, -0, 1e100, Number.NaN],
    nested: { "control\nkey": "value" },
  };
  const expected = JSON.stringify(value);
  const size = new TextEncoder().encode(expected).byteLength;
  expect(stringifyBoundedJson(value, size)).toBe(expected);
  expect(() => stringifyBoundedJson(value, size - 1)).toThrow("JSON size limit");
});
