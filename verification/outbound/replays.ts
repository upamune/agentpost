import { applyD1Migrations, reset, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, vi } from "vitest";
import app from "../../src/api";
import { InboxCoordinator, coordinator, deliver } from "../../src/coordinator";
import { maintain } from "../../src/maintenance";
import type { Env, Outbox } from "../../src/types";

const bindings: Env = env;
export const cases: [string, () => Promise<void>][] = [];
const admin = "test-admin-token-with-at-least-32-characters";
beforeEach(async () => {
  await reset();
  await applyD1Migrations(bindings.DB, env.TEST_MIGRATIONS);
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json({ success: true, result: {} }),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function api(path: string, body?: unknown) {
  return app.request(
    `https://mail.test/v1/${path}`,
    {
      method:
        body === undefined
          ? "GET"
          : path.endsWith("/send") || path === "inboxes"
            ? "POST"
            : "PATCH",
      headers: {
        Authorization: `Bearer ${admin}`,
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    bindings,
  );
}

async function setup() {
  const created = await api("inboxes", {});
  expect(created.status).toBe(201);
  const box = await created.json<{ id: string }>();
  const response = await api(`inboxes/${box.id}/send`, {
    to: ["test@example.net"],
    subject: "Formal verification fixture",
    text: "Fixture only",
  });
  expect(response.status).toBe(202);
  return { box, outbox: await response.json<Outbox>() };
}

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function pauseInboxRead(inboxId: string, point: "before" | "after" = "after") {
  const paused = latch();
  const resumed = latch();
  const queued = latch();
  const stub = coordinator(bindings, inboxId);
  await runInDurableObject(stub, (instance) => {
    const originalEnv: Env = Reflect.get(instance, "env");
    const originalMethod = Reflect.get(instance, "serialize");
    const originalSerialize = originalMethod.bind(instance);
    let operations = 0;
    Reflect.set(instance, "serialize", (operation: () => Promise<unknown>) => {
      const result = originalSerialize(operation);
      if (++operations === 2) queued.release();
      return result;
    });
    const database = new Proxy(originalEnv.DB, {
      get(target, key) {
        if (key !== "prepare") return Reflect.get(target, key);
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (sql !== "SELECT active FROM inboxes WHERE id = ?") return statement;
          return new Proxy(statement, {
            get(prepared, member) {
              if (member !== "bind") return Reflect.get(prepared, member);
              return (...values: unknown[]) => {
                const bound = prepared.bind(...values);
                return new Proxy(bound, {
                  get(query, operation) {
                    if (operation !== "first") return Reflect.get(query, operation);
                    return async () => {
                      if (point === "before") {
                        paused.release();
                        await resumed.promise;
                      }
                      const snapshot = await query.first();
                      if (point === "after") {
                        paused.release();
                        await resumed.promise;
                      }
                      return snapshot;
                    };
                  },
                });
              };
            },
          });
        };
      },
    });
    Reflect.set(instance, "env", { ...originalEnv, DB: database });
  });
  return { paused: paused.promise, queued: queued.promise, resume: resumed.release };
}

async function status(id: string) {
  return (await bindings.DB.prepare("SELECT status FROM outbox WHERE id = ?").bind(id).first())
    ?.status;
}

cases.push([
  "provider accepts the same request at most once with duplicate queue jobs",
  async () => {
    const { outbox } = await setup();
    // Distinct stubs resolve to the same named actor.
    await Promise.all([deliver(bindings, outbox.id), deliver(bindings, outbox.id)]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await status(outbox.id)).toBe("accepted");
  },
]);

cases.push([
  "no new provider request starts after disabling the inbox has completed",
  async () => {
    const { box, outbox } = await setup();
    const second = await (
      await api(`inboxes/${box.id}/send`, {
        to: ["test@example.net"],
        subject: "Second",
        text: "Fixture",
      })
    ).json<Outbox>();
    const gate = await pauseInboxRead(box.id);
    const delivery = deliver(bindings, outbox.id);
    let disabled: Promise<Response> | undefined;
    try {
      await gate.paused;
      disabled = api(`inboxes/${box.id}`, { active: false });
      await gate.queued;
      // The API has reached the actor but cannot complete its write past the live send.
      expect(
        (await bindings.DB.prepare("SELECT active FROM inboxes WHERE id = ?").bind(box.id).first())
          ?.active,
      ).toBe(1);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      gate.resume();
      await delivery;
    }
    expect((await disabled!)?.status).toBe(200);
    expect(await status(outbox.id)).toBe("accepted");
    await deliver(bindings, second.id);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await status(second.id)).toBe("failed");
  },
]);

cases.push([
  "stale worker does not start a provider call after Cron marks the outcome unknown",
  async () => {
    const { box, outbox } = await setup();
    const gate = await pauseInboxRead(box.id, "before");
    const delivery = deliver(bindings, outbox.id);
    let recovery: Promise<void> | undefined;
    try {
      await gate.paused;
      await bindings.DB.prepare("UPDATE outbox SET updated_at = ? WHERE id = ?")
        .bind(Date.now() - 180_000, outbox.id)
        .run();
      recovery = maintain(bindings);
      await gate.queued;
      expect(await status(outbox.id)).toBe("sending");
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      gate.resume();
      await delivery;
    }
    await recovery;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await status(outbox.id)).toBe("accepted");
  },
]);

cases.push([
  "a fresh actor recovers an orphaned sending request without dispatching",
  async () => {
    const { outbox } = await setup();
    await bindings.DB.prepare("UPDATE outbox SET status = 'sending', updated_at = ? WHERE id = ?")
      .bind(Date.now() - 180_000, outbox.id)
      .run();
    await maintain(bindings);
    expect(await status(outbox.id)).toBe("unknown");
    await deliver(bindings, outbox.id);
    expect(fetch).not.toHaveBeenCalled();
  },
]);

cases.push([
  "ownership fence failure after the active read prevents dispatch",
  async () => {
    const { box, outbox } = await setup();
    const stub = coordinator(bindings, box.id);
    await runInDurableObject(stub, (instance) => {
      Reflect.set(instance, "fence", () => {
        throw new Error("Actor ownership lost");
      });
    });
    await expect(deliver(bindings, outbox.id)).rejects.toThrow("Actor ownership lost");
    expect(fetch).not.toHaveBeenCalled();
    expect(await status(outbox.id)).toBe("sending");
  },
]);

cases.push([
  "actor failure releases serialization without allowing a cross-inbox claim",
  async () => {
    const { box, outbox } = await setup();
    const other = await setup();
    const stub = coordinator(bindings, box.id);
    await runInDurableObject(stub, async (instance) => {
      await expect(instance.setActive(other.box.id, false)).rejects.toThrow("identity mismatch");
    });
    await stub.deliver(other.outbox.id, box.id);
    expect(await status(other.outbox.id)).toBe("pending");
    await deliver(bindings, outbox.id);
    expect(fetch).toHaveBeenCalledTimes(1);
  },
]);

cases.push([
  "a delayed old enable cannot overwrite a newer disable after actor handoff",
  async () => {
    const { box, outbox } = await setup();
    const stub = coordinator(bindings, box.id);
    const paused = latch();
    const resumed = latch();
    let replacement!: () => Promise<void>;
    await runInDurableObject(stub, (instance, state) => {
      const originalEnv: Env = Reflect.get(instance, "env");
      const database = new Proxy(originalEnv.DB, {
        get(target, key) {
          if (key !== "prepare") return Reflect.get(target, key);
          return (sql: string) => {
            const statement = target.prepare(sql);
            if (!sql.startsWith("UPDATE inboxes SET active =")) return statement;
            return new Proxy(statement, {
              get(prepared, operation) {
                if (operation !== "bind") return Reflect.get(prepared, operation);
                return (...values: unknown[]) => {
                  const bound = prepared.bind(...values);
                  return new Proxy(bound, {
                    get(query, method) {
                      if (method !== "first") return Reflect.get(query, method);
                      return async () => {
                        paused.release();
                        await resumed.promise;
                        return query.first();
                      };
                    },
                  });
                };
              },
            });
          };
        },
      });
      Reflect.set(instance, "env", { ...originalEnv, DB: database });
      // A second instance over the same real SQLite state models handoff while
      // the old D1 projection is already in flight. No outgoing mail is mocked here.
      replacement = async () => {
        const fresh = new InboxCoordinator(state, originalEnv);
        await fresh.setActive(box.id, false);
      };
    });
    const oldEnable = api(`inboxes/${box.id}`, { active: true });
    try {
      await paused.promise;
      await runInDurableObject(coordinator(bindings, box.id), replacement);
      expect(
        (await bindings.DB.prepare("SELECT active FROM inboxes WHERE id = ?").bind(box.id).first())
          ?.active,
      ).toBe(0);
    } finally {
      resumed.release();
      expect((await oldEnable).status).toBe(500);
    }
    const visible = await (await api(`inboxes/${box.id}`)).json<{ active: number }>();
    expect(visible.active).toBe(0);
    await deliver(bindings, outbox.id);
    expect(fetch).not.toHaveBeenCalled();
  },
]);

cases.push([
  "unknown outcomes never create a new automatic provider attempt",
  async () => {
    const { outbox } = await setup();
    vi.mocked(fetch).mockImplementation(async () => new Response(null, { status: 500 }));
    await deliver(bindings, outbox.id);
    await deliver(bindings, outbox.id);
    await maintain(bindings);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await status(outbox.id)).toBe("unknown");
  },
]);
