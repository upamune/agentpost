import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import app from "../src/api";
import { sha256 } from "../src/common";

const admin = "test-admin-token-with-at-least-32-characters";
const notes = "Registered for receipts.\n日本語のメモと **Markdown**. '); DROP TABLE inboxes; --";
const urls = ["https://shop.example/account?view=receipts#billing", "https://help.example/contact"];

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
afterEach(() => vi.restoreAllMocks());

function request(path = "", method = "GET", body?: unknown, token = admin) {
  return app.request(
    `https://mail.test/v1/inboxes${path}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  );
}
async function create(input: unknown = {}) {
  const response = await request("", "POST", input);
  expect(response.status).toBe(201);
  return response.json<{
    id: string;
    address: string;
    token: string;
    notes: string;
    urls: string[];
  }>();
}

test("existing inboxes migrate with empty metadata and retain identity, label, token and active state", async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.slice(0, -1));
  const id = crypto.randomUUID(),
    hash = await sha256("legacy-inbox-token-with-32-characters");
  await env.DB.prepare(
    "INSERT INTO inboxes (id,address,label,token_hash,active,active_version,created_at) VALUES (?,?,'legacy',?,0,7,123)",
  )
    .bind(id, "legacy@example.com", hash)
    .run();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.slice(-1));
  const response = await request(`/${id}`);
  expect(await response.json()).toEqual({
    id,
    address: "legacy@example.com",
    label: "legacy",
    notes: "",
    urls: [],
    active: 0,
    created_at: 123,
  });
  expect(
    await env.DB.prepare("SELECT token_hash,active_version FROM inboxes WHERE id=?")
      .bind(id)
      .first(),
  ).toEqual({ token_hash: hash, active_version: 7 });
});

test("create/get/list round-trip free-form notes and multiple site URLs without exposing internal columns", async () => {
  const box = await create({ label: "shop", notes, urls });
  expect(box).toMatchObject({ notes, urls });
  const get = await request(`/${box.id}`, "GET", undefined, box.token);
  const details = await get.json();
  expect(details).toEqual({
    id: box.id,
    address: box.address,
    label: "shop",
    notes,
    urls,
    active: 1,
    created_at: expect.any(Number),
  });
  const listed = await (await request()).json<{ items: unknown[] }>();
  expect(listed.items).toEqual([details]);
  expect(await create()).toMatchObject({ notes: "", urls: [] });
});

test("independent concurrent metadata edits preserve other fields and all authorization/send-state columns", async () => {
  const box = await create({ label: "before", notes: "before", urls });
  const before = await env.DB.prepare(
    "SELECT id,address,token_hash,owner_id,active,active_version,created_at FROM inboxes WHERE id=?",
  )
    .bind(box.id)
    .first();
  const results = await Promise.all([
    request(`/${box.id}/metadata`, "PATCH", { label: "after" }),
    request(`/${box.id}/metadata`, "PATCH", { notes }),
    request(`/${box.id}/metadata`, "PATCH", { urls: ["https://new.example/"] }),
  ]);
  expect(results.map((response) => response.status)).toEqual([200, 200, 200]);
  expect(await (await request(`/${box.id}`)).json()).toMatchObject({
    label: "after",
    notes,
    urls: ["https://new.example/"],
  });
  expect(
    await env.DB.prepare(
      "SELECT id,address,token_hash,owner_id,active,active_version,created_at FROM inboxes WHERE id=?",
    )
      .bind(box.id)
      .first(),
  ).toEqual(before);
});

test("explicit empty values clear metadata while omission preserves it, including on disabled inboxes", async () => {
  const box = await create({ label: "site", notes, urls });
  expect((await request(`/${box.id}`, "PATCH", { active: false })).status).toBe(200);
  const before = await env.DB.prepare("SELECT active_version FROM inboxes WHERE id=?")
    .bind(box.id)
    .first();
  expect((await request(`/${box.id}/metadata`, "PATCH", { notes: "", urls: [] })).status).toBe(200);
  expect(await (await request(`/${box.id}`)).json()).toMatchObject({
    label: "site",
    notes: "",
    urls: [],
    active: 0,
  });
  expect((await request(`/${box.id}/metadata`, "PATCH", { label: "" })).status).toBe(200);
  expect(
    await env.DB.prepare("SELECT active_version FROM inboxes WHERE id=?").bind(box.id).first(),
  ).toEqual(before);
});

test("inbox tokens can read their notes but cannot edit metadata or access another inbox", async () => {
  const own = await create({ notes, urls }),
    foreign = await create();
  expect((await request(`/${own.id}`, "GET", undefined, own.token)).status).toBe(200);
  expect(
    (await request(`/${own.id}/metadata`, "PATCH", { notes: "changed" }, own.token)).status,
  ).toBe(403);
  expect(
    (await request(`/${foreign.id}/metadata`, "PATCH", { notes: "changed" }, own.token)).status,
  ).toBe(404);
  expect((await request(`/${foreign.id}`, "GET", undefined, own.token)).status).toBe(404);
  expect((await request(`/${own.id}/metadata`, "PATCH", { notes: "changed" }, "")).status).toBe(
    401,
  );
  expect(await (await request(`/${own.id}`)).json()).toMatchObject({ notes, urls });
});

test("metadata validates bounds and URLs before mutation, rejecting non-metadata fields and empty patches", async () => {
  const box = await create({ notes, urls });
  const invalid = [
    { notes: null },
    { notes: "n".repeat(10_001) },
    { urls: null },
    { urls: "https://site.example" },
    { urls: Array(21).fill("https://site.example/") },
    { urls: ["not-a-url"] },
    { urls: ["javascript:alert(1)"] },
    { urls: ["file:///tmp/private"] },
    { urls: ["ftp://site.example/"] },
    { urls: ["https://user:secret@site.example/"] },
    { urls: ["https://%61lice@site.example/"] },
    { urls: [" https://site.example/"] },
    { urls: ["https://site.example/\n"] },
    { urls: [`https://site.example/${"a".repeat(2048)}`] },
  ];
  for (const input of invalid) {
    expect((await request("", "POST", input)).status, JSON.stringify(input).slice(0, 100)).toBe(
      400,
    );
    expect((await request(`/${box.id}/metadata`, "PATCH", input)).status).toBe(400);
  }
  for (const input of [
    {},
    { active: false },
    { address: "other@example.com" },
    { owner_id: "other" },
    { local_part: "rename" },
    { token_hash: "new" },
    { notes: "ok", active: true },
  ]) {
    expect((await request(`/${box.id}/metadata`, "PATCH", input)).status).toBe(400);
  }
  const rows = await env.DB.prepare("SELECT count(*) AS count FROM inboxes").first();
  expect(rows).toEqual({ count: 1 });
  expect(await (await request(`/${box.id}`)).json()).toMatchObject({ notes, urls, active: 1 });
});

test("reference URLs are stored verbatim without any outbound fetch, including local/private references", async () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("No URL fetching allowed"));
  const references = ["http://localhost:3000/account", "https://192.168.1.2/billing", ...urls];
  const box = await create({ urls: references });
  expect(await (await request(`/${box.id}`)).json()).toMatchObject({ urls: references });
  expect((await request(`/${box.id}/metadata`, "PATCH", { urls: references })).status).toBe(200);
  expect(fetch).not.toHaveBeenCalled();
});
