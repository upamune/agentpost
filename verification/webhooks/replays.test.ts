import { applyD1Migrations, reset, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { webhookDispatchBarrier } from "../../src/dispatch-barrier";
import { createWebhookConfig } from "../../src/webhook-crypto";
import { processWebhook } from "../../src/webhook-delivery";
import { saveWebhook, type WebhookDelivery } from "../../src/webhook-store";
import type { Env } from "../../src/types";
import { InboxCoordinator, coordinator } from "../../src/coordinator";

const bindings: Env = env;
beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
afterEach(() => vi.restoreAllMocks());

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function setup() {
  const inbox = crypto.randomUUID();
  const message = "a".repeat(64);
  await env.DB.prepare(
    "INSERT INTO inboxes (id,address,label,token_hash,created_at) VALUES (?,?,?,?,?)",
  )
    .bind(inbox, `${inbox}@example.com`, "Verification fixture", crypto.randomUUID(), Date.now())
    .run();
  const config = await createWebhookConfig(
    bindings,
    inbox,
    "https://receiver.example.org/original",
  );
  await saveWebhook(bindings, inbox, config.id, config.encrypted, 1);
  await env.DB.prepare(
    "INSERT INTO messages (id,inbox_id,raw_key,envelope_from,envelope_to,created_at) VALUES (?,?,?,?,?,?)",
  )
    .bind(message, inbox, `${inbox}/raw`, "sender@example.net", `${inbox}@example.com`, Date.now())
    .run();
  await env.DB.prepare("UPDATE messages SET status = 'ready' WHERE id = ?").bind(message).run();
  const row = await env.DB.prepare("SELECT * FROM webhook_deliveries WHERE message_id = ?")
    .bind(message)
    .first<WebhookDelivery>();
  expect(row).not.toBeNull();
  return { inbox, config, row: row! };
}

test("configuration replay retains a completed deletion against a late older write", async () => {
  const { inbox, config } = await setup();
  expect(await saveWebhook(bindings, inbox, crypto.randomUUID(), null, 3)).toBe(true);
  expect(await saveWebhook(bindings, inbox, config.id, config.encrypted, 2)).toBe(false);
  const stored = await env.DB.prepare(
    "SELECT enabled,version FROM inbox_webhooks WHERE inbox_id = ?",
  )
    .bind(inbox)
    .first();
  expect(stored).toEqual({ enabled: 0, version: 3 });
});

test("conditional claim replay ignores a duplicate queue delivery while sending", async () => {
  const { inbox, row } = await setup();
  await env.DB.prepare(
    "UPDATE webhook_deliveries SET status = 'sending',claim_token = ?,updated_at = ? WHERE id = ?",
  )
    .bind(crypto.randomUUID(), Date.now(), row.id)
    .run();
  const network = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(null, { status: 204 }));
  await processWebhook(
    bindings,
    row.id,
    inbox,
    () => {},
    async () => true,
  );
  expect(network).not.toHaveBeenCalled();
});

test("ownership fence replay prevents HTTP after the worker loses ownership", async () => {
  const { inbox, row } = await setup();
  const network = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(null, { status: 204 }));
  const result = await processWebhook(
    bindings,
    row.id,
    inbox,
    () => {
      throw new Error("Ownership lost");
    },
    async () => true,
  ).catch((error: unknown) => error);
  expect(network).not.toHaveBeenCalled();
  expect(result).toBeInstanceOf(Error);
});

test("claim token replay keeps an old response from settling a newer claim", async () => {
  const { inbox, row } = await setup();
  const started = [latch(), latch()];
  const replies = [latch(), latch()];
  let calls = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    const index = calls++;
    started[index]!.release();
    await replies[index]!.promise;
    return new Response(null, { status: 204 });
  });
  const first = processWebhook(
    bindings,
    row.id,
    inbox,
    () => {},
    async () => true,
  );
  await started[0]!.promise;
  await env.DB.prepare("UPDATE webhook_deliveries SET updated_at = 0 WHERE id = ?")
    .bind(row.id)
    .run();
  const second = processWebhook(
    bindings,
    row.id,
    inbox,
    () => {},
    async () => true,
  );
  await started[1]!.promise;
  const newer = await env.DB.prepare("SELECT claim_token FROM webhook_deliveries WHERE id = ?")
    .bind(row.id)
    .first<{ claim_token: string }>();
  replies[0]!.release();
  await first;
  const beforeNewReply = await env.DB.prepare(
    "SELECT status,claim_token FROM webhook_deliveries WHERE id = ?",
  )
    .bind(row.id)
    .first();
  replies[1]!.release();
  await second;
  expect(beforeNewReply).toEqual({ status: "sending", claim_token: newer!.claim_token });
});

test("dispatch barrier replay rejects an old configuration projection after preparation", async () => {
  const { inbox, config } = await setup();
  const replacement = await createWebhookConfig(
    bindings,
    inbox,
    "https://receiver.example.org/replacement",
  );
  const gate = latch();
  const delayed: Env = {
    ...bindings,
    DB: new Proxy(env.DB, {
      get(target, key) {
        if (key === "batch")
          return async (statements: D1PreparedStatement[]) => {
            await gate.promise;
            return target.batch(statements);
          };
        const value: unknown = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  };
  const oldProjection = saveWebhook(delayed, inbox, replacement.id, replacement.encrypted, 2);
  const confirmed = await webhookDispatchBarrier(bindings, inbox, config.id, 3);
  gate.release();
  const oldAccepted = await oldProjection;
  expect(confirmed).toBe(true);
  expect(oldAccepted).toBe(false);
  const current = await env.DB.prepare("SELECT id,version FROM inbox_webhooks WHERE inbox_id = ?")
    .bind(inbox)
    .first();
  expect(current).toEqual({ id: config.id, version: 3 });
});

test("a configuration projection that commits before the barrier cancels captured dispatch", async () => {
  const { inbox, row } = await setup();
  const replacement = await createWebhookConfig(
    bindings,
    inbox,
    "https://receiver.example.org/replacement",
  );
  const network = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(null, { status: 204 }));
  await processWebhook(
    bindings,
    row.id,
    inbox,
    () => {},
    async (captured) => {
      expect(await saveWebhook(bindings, inbox, replacement.id, replacement.encrypted, 2)).toBe(
        true,
      );
      return webhookDispatchBarrier(bindings, inbox, captured, 3);
    },
  );
  expect(network).not.toHaveBeenCalled();
  expect(
    await env.DB.prepare("SELECT status FROM webhook_deliveries WHERE id = ?").bind(row.id).first(),
  ).toEqual({ status: "cancelled" });
});

test("the webhook barrier rejects a delayed older inbox disable before starting HTTP", async () => {
  const { inbox, row } = await setup();
  const network = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(null, { status: 204 }));
  let oldAccepted = true;
  await processWebhook(
    bindings,
    row.id,
    inbox,
    () => {},
    async (captured) => {
      const confirmed = await webhookDispatchBarrier(bindings, inbox, captured, 3);
      const update = await env.DB.prepare(
        "UPDATE inboxes SET active = 0, active_version = 2 WHERE id = ? AND active_version < 2 RETURNING id",
      )
        .bind(inbox)
        .first();
      oldAccepted = update !== null;
      return confirmed;
    },
  );
  expect(oldAccepted).toBe(false);
  expect(network).toHaveBeenCalledTimes(1);
  expect(
    await env.DB.prepare("SELECT active,active_version FROM inboxes WHERE id = ?")
      .bind(inbox)
      .first(),
  ).toEqual({ active: 1, active_version: 3 });
});

test("a coordinator handoff during the committed barrier await cannot start HTTP", async () => {
  const { inbox, row } = await setup();
  const network = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(null, { status: 204 }));
  // The runtime cannot manufacture an ownership partition. Inject its documented
  // synchronous storage rejection while both instances share actual SQLite/D1.
  await runInDurableObject(coordinator(bindings, inbox), async (instance, state) => {
    const originalEnv: Env = Reflect.get(instance, "env");
    const originalFence = Reflect.get(instance, "fence").bind(instance);
    await instance.setActive(inbox, true);
    let owned = true;
    Reflect.set(instance, "fence", () => {
      if (!owned) throw new Error("Ownership lost during webhook barrier");
      return originalFence();
    });
    const paused = latch();
    const resumed = latch();
    const database = new Proxy(originalEnv.DB, {
      get(target, key) {
        if (key === "batch")
          return async (statements: D1PreparedStatement[]) => {
            const result = await target.batch(statements);
            paused.release();
            await resumed.promise;
            return result;
          };
        const value: unknown = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    Reflect.set(instance, "env", { ...originalEnv, DB: database });
    const completed = instance.deliverWebhook(row.id, inbox).catch((error: unknown) => error);
    await paused.promise;
    owned = false;
    try {
      const replacement = new InboxCoordinator(state, originalEnv);
      await replacement.setWebhook(inbox, null);
    } finally {
      resumed.release();
    }
    const error = await completed;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("Ownership lost during webhook barrier");
  });
  expect(network).not.toHaveBeenCalled();
});
