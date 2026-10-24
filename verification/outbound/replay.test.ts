import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import app from "../../src/api";
import { deliver } from "../../src/outbound";
import { maintain } from "../../src/maintenance";
import type { Env, Outbox } from "../../src/types";

const bindings: Env = env;
const admin = "test-admin-token-with-at-least-32-characters";
beforeEach(async () => {
  await reset();
  await applyD1Migrations(bindings.DB, env.TEST_MIGRATIONS);
});
afterEach(() => vi.useRealTimers());

async function setup() {
  const created = await app.request(
    "https://mail.test/v1/inboxes",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${admin}`, "Content-Type": "application/json" },
      body: "{}",
    },
    bindings,
  );
  const box = await created.json<{ id: string }>();
  const response = await app.request(
    `https://mail.test/v1/inboxes/${box.id}/send`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${admin}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "formal-request",
      },
      body: JSON.stringify({
        to: ["test@example.net"],
        subject: "Formal verification fixture",
        text: "Fixture only",
      }),
    },
    bindings,
  );
  expect(response.status).toBe(202);
  return { box, outbox: await response.json<Outbox>() };
}

function pauseInboxRead(point: "before" | "after" = "after") {
  let resume!: () => void;
  let notify!: () => void;
  const paused = new Promise<void>((resolve) => {
    notify = resolve;
  });
  const released = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const database = new Proxy(bindings.DB, {
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
                  return async (...args: Parameters<D1PreparedStatement["first"]>) => {
                    if (point === "before") {
                      notify();
                      await released;
                    }
                    const snapshot = await query.first(...args);
                    if (point === "after") {
                      notify();
                      await released;
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
  return { environment: { ...bindings, DB: database }, paused, resume };
}

test("provider accepts the same request at most once with duplicate queue jobs", async () => {
  const { outbox } = await setup();
  let calls = 0;
  const sender = async () => {
    calls++;
    return { status: "accepted" as const, result: "{}" };
  };
  await Promise.all([deliver(bindings, outbox.id, sender), deliver(bindings, outbox.id, sender)]);
  expect(calls).toBe(1);
});

test("no new provider request starts after disabling the inbox has completed", async () => {
  const { box, outbox } = await setup();
  const gate = pauseInboxRead();
  let calls = 0;
  const delivery = deliver(gate.environment, outbox.id, async () => {
    calls++;
    return { status: "accepted", result: "{}" };
  });
  try {
    await gate.paused;
    expect(calls).toBe(0);
    const disabled = await app.request(
      `https://mail.test/v1/inboxes/${box.id}`,
      {
        method: "PATCH",
        headers: { Authorization: `Bearer ${admin}`, "Content-Type": "application/json" },
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
    gate.resume();
  }
  await delivery;
  console.info(
    JSON.stringify({
      finding: "disabled-inbox",
      provider_calls: calls,
      visible_status: (
        await (
          await app.request(
            `https://mail.test/v1/inboxes/${box.id}/outbox/${outbox.id}`,
            { headers: { Authorization: `Bearer ${admin}` } },
            bindings,
          )
        ).json<Outbox>()
      ).status,
    }),
  );
  expect(calls, "Provider call started only after the disable API returned 200").toBe(0);
});

test("stale worker does not start a provider call after Cron marks the outcome unknown", async () => {
  const { outbox } = await setup();
  const gate = pauseInboxRead("before");
  let calls = 0;
  const delivery = deliver(gate.environment, outbox.id, async () => {
    calls++;
    return { status: "accepted", result: "{}" };
  });
  try {
    await gate.paused;
    expect(calls).toBe(0);
    // Only the clock advances: production maintenance performs the actual stale transition.
    vi.setSystemTime(Date.now() + 3 * 60_000);
    await maintain(bindings);
    expect(
      (await bindings.DB.prepare("SELECT status FROM outbox WHERE id = ?").bind(outbox.id).first())
        ?.status,
    ).toBe("unknown");
  } finally {
    gate.resume();
  }
  await delivery;
  console.info(
    JSON.stringify({
      finding: "stale-worker",
      provider_calls: calls,
      visible_status: (
        await (
          await app.request(
            `https://mail.test/v1/inboxes/${outbox.inbox_id}/outbox/${outbox.id}`,
            { headers: { Authorization: `Bearer ${admin}` } },
            bindings,
          )
        ).json<Outbox>()
      ).status,
    }),
  );
  expect(calls, "A delayed provider call started after outcome became unknown").toBe(0);
});
