import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, expect, test } from "vitest";
import app from "../../src/api";
import { sha256 } from "../../src/common";
import { parseMessage, receive, repairRawIndex } from "../../src/inbound";
import { maintain } from "../../src/maintenance";
import type { Env, Message, Job } from "../../src/types";

const bindings: Env = env;
const admin = "test-admin-token-with-at-least-32-characters";
const raw =
  "From: sender@example.net\r\nTo: recipient@example.com\r\nSubject: Recovery fixture\r\n\r\nRetain this original.\r\n";
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
  return response.json<{ id: string; address: string }>();
}

function email(to: string): ForwardableEmailMessage {
  const bytes = new TextEncoder().encode(raw);
  return {
    from: "sender@example.net",
    to,
    rawSize: bytes.length,
    headers: new Headers(),
    raw: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    setReject() {
      throw new Error("Unexpected rejection");
    },
    async forward() {
      throw new Error("Unexpected forward");
    },
    async reply() {
      throw new Error("Unexpected reply");
    },
  };
}

// Inject a failed SQL operation, preserving the real SQL and D1 for every other step.
function failSql(match: string, method: "run" | "first" | "all" = "run"): Env {
  let remaining = 1;
  const database = new Proxy(bindings.DB, {
    get(target, key) {
      if (key !== "prepare") return Reflect.get(target, key);
      return (sql: string) => {
        function wrap(statement: D1PreparedStatement): D1PreparedStatement {
          return new Proxy(statement, {
            get(prepared, operation) {
              if (operation === "bind")
                return (...values: unknown[]) => wrap(prepared.bind(...values));
              if (operation === method && sql.includes(match) && remaining > 0)
                return async () => {
                  remaining--;
                  throw new Error("Injected D1 failure");
                };
              const value = Reflect.get(prepared, operation);
              return typeof value === "function" ? value.bind(prepared) : value;
            },
          });
        }
        return wrap(target.prepare(sql));
      };
    },
  });
  return { ...bindings, DB: database };
}

async function original(box: { id: string; address: string }, environment = bindings) {
  const id = await sha256(`${box.id}:${await sha256(raw)}`);
  const key = `raw/${box.id}/${id}.eml`;
  return { id, key, receive: () => receive(email(box.address), environment) };
}

async function getMessage(id: string) {
  return bindings.DB.prepare("SELECT * FROM messages WHERE id = ?").bind(id).first<Message>();
}

async function health() {
  return app.request(
    "https://mail.test/v1/health",
    { headers: { Authorization: `Bearer ${admin}` } },
    bindings,
  );
}

test("a D1 failure after raw persistence is repaired from the original metadata", async () => {
  const box = await createInbox();
  const mail = await original(box, failSql("INSERT OR IGNORE INTO messages"));
  await expect(mail.receive()).rejects.toThrow("Injected D1 failure");
  expect(await getMessage(mail.id)).toBeNull();
  expect(await (await bindings.MAIL.get(mail.key))?.text()).toBe(raw);
  await maintain(bindings);
  expect((await getMessage(mail.id))?.status).toBe("pending");
  await parseMessage(bindings, mail.id);
  expect((await getMessage(mail.id))?.status).toBe("ready");
  expect(await (await bindings.MAIL.get(mail.key))?.text()).toBe(raw);
});

test("queue outage and duplicate recovery preserve one message and one received event", async () => {
  const box = await createInbox();
  const offline: Env = {
    ...bindings,
    JOBS: {
      ...bindings.JOBS,
      async send() {
        throw new Error("Queue down");
      },
    },
  };
  const mail = await original(box, offline);
  await mail.receive();
  const published: Job[] = [];
  await maintain({
    ...bindings,
    JOBS: {
      ...bindings.JOBS,
      async send(job) {
        published.push(job);
        return bindings.JOBS.send(job);
      },
    },
  });
  expect(published).toContainEqual({ kind: "inbound", id: mail.id });
  await parseMessage(bindings, mail.id);
  await parseMessage(bindings, mail.id);
  await repairRawIndex(bindings);
  expect((await getMessage(mail.id))?.status).toBe("ready");
  expect((await bindings.DB.prepare("SELECT count(*) AS n FROM messages").first())?.n).toBe(1);
  expect(
    (
      await bindings.DB.prepare(
        "SELECT count(*) AS n FROM events WHERE name = 'message.received'",
      ).first()
    )?.n,
  ).toBe(1);
});

test("failures before parsed storage and before ready commit retain the original and recover", async () => {
  const box = await createInbox();
  const mail = await original(box);
  await mail.receive();
  const broken: Env = {
    ...bindings,
    MAIL: new Proxy(bindings.MAIL, {
      get(target, key) {
        if (key === "put")
          return async () => {
            throw new Error("R2 down");
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  };
  await expect(parseMessage(broken, mail.id)).rejects.toThrow("R2 down");
  expect((await getMessage(mail.id))?.status).toBe("pending");
  expect(await bindings.MAIL.head(`parsed/${mail.id}.json`)).toBeNull();
  await expect(
    parseMessage(failSql("UPDATE messages SET status = 'ready'"), mail.id),
  ).rejects.toThrow("Injected D1 failure");
  expect(await bindings.MAIL.head(`parsed/${mail.id}.json`)).not.toBeNull();
  expect((await getMessage(mail.id))?.status).toBe("pending");
  expect(await (await bindings.MAIL.get(mail.key))?.text()).toBe(raw);
  await parseMessage(bindings, mail.id);
  expect((await getMessage(mail.id))?.status).toBe("ready");
});

test("poisoned first page cannot starve healthy later raw objects and stays visible in health", async () => {
  const box = await createInbox();
  const mail = await original(box);
  await mail.receive();
  await bindings.DB.prepare("DELETE FROM messages").run();
  const poison = "raw/!poison.eml";
  await bindings.MAIL.put(poison, "Poison original");
  const paged: Env = {
    ...bindings,
    MAIL: { ...bindings.MAIL, list: (options) => bindings.MAIL.list({ ...options, limit: 1 }) },
  };
  await expect(repairRawIndex(paged)).rejects.toThrow("unresolved objects");
  const cursor = await bindings.DB.prepare(
    "SELECT value FROM maintenance WHERE key = 'raw_cursor'",
  ).first<{ value: string }>();
  expect(cursor?.value).toBeTruthy();
  const failure = await bindings.DB.prepare(
    "SELECT error_code FROM raw_recovery_failures WHERE raw_key = ?",
  )
    .bind(poison)
    .first();
  expect(failure?.error_code).toBe("invalid_metadata");
  const response = await health();
  expect(response.status).toBe(503);
  expect((await response.json<{ raw_recovery_failures: number }>()).raw_recovery_failures).toBe(1);
  await repairRawIndex(paged);
  expect((await getMessage(mail.id))?.status).toBe("pending");
  expect(await (await bindings.MAIL.get(poison))?.text()).toBe("Poison original");
  await parseMessage(bindings, mail.id);
  expect((await getMessage(mail.id))?.status).toBe("ready");
});

test("orphaned inbox metadata is reported, retried and cleared after the inbox is restored", async () => {
  const box = await createInbox();
  const mail = await original(box);
  await mail.receive();
  const saved = await bindings.DB.prepare("SELECT * FROM inboxes WHERE id = ?").bind(box.id).first<{
    id: string;
    address: string;
    label: string;
    token_hash: string;
    created_at: number;
  }>();
  await bindings.DB.prepare("DELETE FROM messages").run();
  await bindings.DB.prepare("DELETE FROM inboxes WHERE id = ?").bind(box.id).run();
  await expect(repairRawIndex(bindings)).rejects.toThrow("unresolved objects");
  expect(
    (await bindings.DB.prepare("SELECT error_code FROM raw_recovery_failures").first())?.error_code,
  ).toBe("missing_inbox");
  await bindings.DB.prepare(
    "INSERT INTO inboxes (id,address,label,token_hash,created_at) VALUES (?,?,?,?,?)",
  )
    .bind(saved!.id, saved!.address, saved!.label, saved!.token_hash, saved!.created_at)
    .run();
  await repairRawIndex(bindings);
  expect((await getMessage(mail.id))?.status).toBe("pending");
  expect(
    (await bindings.DB.prepare("SELECT count(*) AS n FROM raw_recovery_failures").first())?.n,
  ).toBe(0);
  expect((await health()).status).toBe(200);
});

test("cursor commit failure repeats safe inserts without downgrading ready messages", async () => {
  const box = await createInbox();
  const mail = await original(box);
  await mail.receive();
  await parseMessage(bindings, mail.id);
  await expect(repairRawIndex(failSql("INSERT INTO maintenance"))).rejects.toThrow(
    "Injected D1 failure",
  );
  await repairRawIndex(bindings);
  expect((await getMessage(mail.id))?.status).toBe("ready");
  expect(
    (
      await bindings.DB.prepare(
        "SELECT count(*) AS n FROM events WHERE name = 'message.received'",
      ).first()
    )?.n,
  ).toBe(1);
});

test("failed inbound republishing does not prevent outbound republishing", async () => {
  const box = await createInbox();
  const response = await app.request(
    `https://mail.test/v1/inboxes/${box.id}/send`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${admin}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "pending-recovery",
      },
      body: JSON.stringify({ to: ["test@example.net"], subject: "Recovery", text: "Fixture" }),
    },
    bindings,
  );
  const send = await response.json<{ id: string }>();
  const published: Job[] = [];
  const broken = failSql("SELECT id FROM messages", "all");
  await expect(
    maintain({
      ...broken,
      JOBS: {
        ...bindings.JOBS,
        async send(job) {
          published.push(job);
          return bindings.JOBS.send(job);
        },
      },
    }),
  ).rejects.toThrow("Scheduled recovery failed");
  expect(published).toContainEqual({ kind: "outbound", id: send.id });
});

test("failed attention persistence keeps the cursor before the poisoned original", async () => {
  await bindings.MAIL.put("raw/!poison.eml", "Retained original");
  await expect(repairRawIndex(failSql("INSERT INTO raw_recovery_failures"))).rejects.toThrow(
    "Injected D1 failure",
  );
  expect(
    await bindings.DB.prepare("SELECT value FROM maintenance WHERE key = 'raw_cursor'").first(),
  ).toBeNull();
  await expect(repairRawIndex(bindings)).rejects.toThrow("unresolved objects");
  expect(
    (await bindings.DB.prepare("SELECT count(*) AS n FROM raw_recovery_failures").first())?.n,
  ).toBe(1);
});
