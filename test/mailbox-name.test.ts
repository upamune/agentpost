import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import app from "../src/api";
import { randomMailboxName } from "../src/mailbox-name";
import { sha256 } from "../src/common";

const admin = "test-admin-token-with-at-least-32-characters";

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
afterEach(() => vi.restoreAllMocks());

function chooseNames(next: () => number) {
  const original = crypto.getRandomValues.bind(crypto);
  return vi.spyOn(crypto, "getRandomValues").mockImplementation((array) => {
    if (array instanceof Uint16Array && array.length === 3) {
      array.fill(next());
      return array;
    }
    return original(array);
  });
}

function create(local_part?: string) {
  return app.request(
    "https://mail.test/v1/inboxes",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${admin}`, "Content-Type": "application/json" },
      body: JSON.stringify({ label: "shop.example", local_part }),
    },
    env,
  );
}

test("the 512-word vocabulary is distinct, short ASCII and wraps at sample-space boundaries", () => {
  let sample = 0;
  chooseNames(() => sample);
  const names = new Set<string>();
  for (sample = 0; sample < 512; sample++) {
    const name = randomMailboxName();
    expect(name).toMatch(/^[a-z]{2,8}-[a-z]{2,8}-[a-z]{2,8}$/);
    expect(new Set(name.split("-")).size).toBe(1);
    names.add(name);
  }
  expect(names.size).toBe(512);
  sample = 65535;
  expect(randomMailboxName()).toBe([...names].at(-1));
  sample = 512;
  expect(randomMailboxName()).toBe([...names][0]);
});

test("each position uses its own random sample", () => {
  const original = crypto.getRandomValues.bind(crypto);
  vi.spyOn(crypto, "getRandomValues").mockImplementation((array) => {
    if (array instanceof Uint16Array && array.length === 3) {
      array.set([0, 1, 2]);
      return array;
    }
    return original(array);
  });
  expect(new Set(randomMailboxName().split("-")).size).toBe(3);
});

test("a generated collision retries the atomic insert without taking over a disabled inbox", async () => {
  chooseNames(() => 0);
  const response = await create();
  const existing = await response.json<{ id: string; address: string; token: string }>();
  expect(response.status).toBe(201);
  await env.DB.prepare("UPDATE inboxes SET active = 0 WHERE id = ?").bind(existing.id).run();
  let draw = 0;
  vi.restoreAllMocks();
  chooseNames(() => (draw++ === 0 ? 0 : 1));
  const retry = await create();
  const fresh = await retry.json<{ id: string; address: string; token: string }>();
  expect(retry.status).toBe(201);
  expect(draw).toBe(2);
  expect(fresh.address).not.toBe(existing.address);
  expect(fresh.id).not.toBe(existing.id);
  expect(fresh.token).not.toBe(existing.token);
  expect(
    await env.DB.prepare("SELECT active, token_hash FROM inboxes WHERE id = ?")
      .bind(existing.id)
      .first(),
  ).toEqual({ active: 0, token_hash: await sha256(existing.token) });
});

test("generated allocation stops after eight collisions; explicit collisions stay 409", async () => {
  let draws = 0;
  chooseNames(() => {
    draws++;
    return 0;
  });
  const first = await create();
  const box = await first.json<{ address: string }>();
  const exhausted = await create();
  expect(exhausted.status).toBe(503);
  expect(await exhausted.json()).toEqual({
    error: "Could not allocate a unique email address. Try again later.",
  });
  expect(draws).toBe(9);
  const explicit = await create(box.address.split("@")[0]);
  expect(explicit.status).toBe(409);
  expect(draws).toBe(9);
  expect((await env.DB.prepare("SELECT count(*) AS n FROM inboxes").first())?.n).toBe(1);
});

test("concurrent generated claims never replace another inbox's credentials", async () => {
  chooseNames(() => 0);
  const responses = await Promise.all([create(), create()]);
  expect(responses.map((response) => response.status).sort()).toEqual([201, 503]);
  const winner = await responses
    .find((response) => response.status === 201)!
    .json<{ id: string; token: string }>();
  expect(await env.DB.prepare("SELECT id, token_hash FROM inboxes").first()).toEqual({
    id: winner.id,
    token_hash: await sha256(winner.token),
  });
});
