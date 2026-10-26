import { applyD1Migrations, reset, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import app from "../src/api";
import { InboxCoordinator, coordinator, deliver } from "../src/coordinator";
import type { Env } from "../src/types";

const bindings: Env = env;
const admin = "test-admin-token-with-at-least-32-characters";

beforeEach(async () => {
  await reset();
  await applyD1Migrations(bindings.DB, env.TEST_MIGRATIONS);
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
  const created = await app.request(
    "https://mail.test/v1/inboxes",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${admin}`, "Content-Type": "application/json" },
      body: "{}",
    },
    bindings,
  );
  expect(created.status).toBe(201);
  const inbox = await created.json<{ id: string; token: string }>();
  const upload = await app.request(
    `https://mail.test/v1/inboxes/${inbox.id}/attachments`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${inbox.token}`,
        "Content-Type": "application/octet-stream",
        "Agentpost-Filename": "report.csv",
      },
      body: "name,value\nanswer,42\n",
    },
    bindings,
  );
  expect(upload.status).toBe(201);
  const attachment = await upload.json<{ id: string }>();
  const queued = await app.request(
    `https://mail.test/v1/inboxes/${inbox.id}/send`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${inbox.token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "attachment-ownership-handoff",
      },
      body: JSON.stringify({
        to: ["fixture@example.net"],
        subject: "Attachment handoff fixture",
        text: "Local fixture only.",
        attachments: [attachment.id],
      }),
    },
    bindings,
  );
  expect(queued.status).toBe(202);
  return { inbox, outbox: await queued.json<{ id: string }>() };
}

test("a replaced coordinator cannot dispatch after attachment I/O resumes behind a completed disable and recovery", async () => {
  // Keep this scheduling replay in its own test isolate. The test runtime cannot
  // create a real ownership partition, so inject its documented storage failure.
  const { inbox, outbox } = await setup();
  const provider = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(Response.json({ success: true, result: { id: "must-never-be-called" } }));
  const paused = latch();
  const resumed = latch();
  const fence = vi.fn();
  let replace!: () => Promise<void>;
  const stub = coordinator(bindings, inbox.id);
  await runInDurableObject(stub, (instance, state) => {
    const originalEnv: Env = Reflect.get(instance, "env");
    const originalFence = Reflect.get(instance, "fence").bind(instance);
    let owned = true;
    Reflect.set(instance, "fence", () => {
      fence();
      if (!owned) throw new Error("Actor ownership lost during attachment read");
      return originalFence();
    });
    const mail = new Proxy(originalEnv.MAIL, {
      get(target, property) {
        if (property === "get")
          return async (key: string) => {
            const object = await target.get(key);
            const content = await object?.arrayBuffer();
            expect(key).toMatch(/^outbound-attachments\//);
            paused.release();
            await resumed.promise;
            // Materialize the real bytes before yielding across the injected
            // handoff; R2 response streams cannot cross test request contexts.
            return (
              object &&
              new Proxy(object, {
                get(stored, member) {
                  return member === "body"
                    ? new Response(content).body
                    : Reflect.get(stored, member);
                },
              })
            );
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    Reflect.set(instance, "env", { ...originalEnv, MAIL: mail });
    replace = async () => {
      owned = false;
      // Both instances use the real Object SQLite state and the same real D1.
      const replacement = new InboxCoordinator(state, originalEnv);
      await replacement.setActive(inbox.id, false);
      await replacement.recover(inbox.id, outbox.id);
    };
  });
  const delivery = deliver(bindings, outbox.id);
  const completion = delivery.then(
    () => undefined,
    (error: unknown) => error,
  );
  try {
    await paused.promise;
    expect(provider).not.toHaveBeenCalled();
    expect(fence).not.toHaveBeenCalled();
    await bindings.DB.prepare("UPDATE outbox SET updated_at = ? WHERE id = ?")
      .bind(Date.now() - 180_000, outbox.id)
      .run();
    await runInDurableObject(coordinator(bindings, inbox.id), replace);
    expect(
      await bindings.DB.prepare("SELECT active FROM inboxes WHERE id = ?").bind(inbox.id).first(),
    ).toEqual({ active: 0 });
    expect(
      await bindings.DB.prepare("SELECT status FROM outbox WHERE id = ?").bind(outbox.id).first(),
    ).toEqual({ status: "unknown" });
  } finally {
    resumed.release();
    await completion;
  }
  const error = await completion;
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("Actor ownership lost during attachment read");
  expect(fence).toHaveBeenCalledTimes(1);
  expect(provider).not.toHaveBeenCalled();
  await deliver(bindings, outbox.id);
  expect(provider).not.toHaveBeenCalled();
  expect(
    await bindings.DB.prepare("SELECT status FROM outbox WHERE id = ?").bind(outbox.id).first(),
  ).toEqual({ status: "unknown" });
});
