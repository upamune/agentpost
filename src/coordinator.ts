import { outboundDispatchBarrier, webhookDispatchBarrier } from "./dispatch-barrier";
import { DurableObject } from "cloudflare:workers";
import { createWebhookConfig } from "./webhook-crypto";
import { processWebhook } from "./webhook-delivery";
import { publicWebhook, saveWebhook } from "./webhook-store";
import { processOutbound } from "./outbound";
import type { Env } from "./types";

/** Every send, active-state change and stale-send recovery for an inbox uses this actor. */
export class InboxCoordinator extends DurableObject<Env> {
  private tail: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS dispatch_fence (id INTEGER PRIMARY KEY CHECK(id = 1), sequence INTEGER NOT NULL)",
    );
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO dispatch_fence VALUES (1, 0)");
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  private fence(): number {
    // Synchronous storage access rejects a replaced/partitioned actor. Its output
    // gate also holds the following fetch until this write is durable.
    const { sequence } = this.ctx.storage.sql
      .exec<{ sequence: number }>(
        "UPDATE dispatch_fence SET sequence = sequence + 1 WHERE id = 1 RETURNING sequence",
      )
      .one();
    if (!Number.isSafeInteger(sequence)) throw new Error("Coordinator sequence exhausted");
    return sequence;
  }

  async deliver(id: string, inboxId: string): Promise<void> {
    this.checkIdentity(inboxId);
    return this.serialize(() =>
      processOutbound(
        this.env,
        id,
        inboxId,
        () => this.fence(),
        () => outboundDispatchBarrier(this.env, inboxId, this.fence()),
      ),
    );
  }

  async deliverWebhook(id: string, inboxId: string): Promise<void> {
    this.checkIdentity(inboxId);
    return this.serialize(() =>
      processWebhook(
        this.env,
        id,
        inboxId,
        () => this.fence(),
        (webhook) => webhookDispatchBarrier(this.env, inboxId, webhook, this.fence()),
      ),
    );
  }

  async setWebhook(inboxId: string, url: string | null) {
    this.checkIdentity(inboxId);
    return this.serialize(async () => {
      const config =
        url === null
          ? { id: crypto.randomUUID(), encrypted: null, secret: undefined }
          : await createWebhookConfig(this.env, inboxId, url);
      const saved = await saveWebhook(this.env, inboxId, config.id, config.encrypted, this.fence());
      if (!saved)
        return {
          error: "Webhook update superseded or inbox disabled; inspect current configuration",
        };
      const current = await publicWebhook(this.env, inboxId);
      if (!("id" in current) || current.id !== config.id)
        return { error: "Webhook update superseded; inspect current configuration" };
      return { ...current, ...(config.secret ? { secret: config.secret } : {}) };
    });
  }

  async setActive(inboxId: string, active: boolean): Promise<void> {
    this.checkIdentity(inboxId);
    return this.serialize(async () => {
      const version = this.fence();
      // A replaced actor may already have a D1 write in flight. Prevent that old
      // projection from overwriting a newer disable/enable after handoff.
      const updated = await this.env.DB.prepare(
        "UPDATE inboxes SET active = ?, active_version = ? WHERE id = ? AND active_version < ? RETURNING id",
      )
        .bind(active ? 1 : 0, version, inboxId, version)
        .first<{ id: string }>();
      if (!updated) throw new Error("Inbox active update was superseded; inspect current state");
    });
  }

  async recover(inboxId: string, id: string): Promise<void> {
    this.checkIdentity(inboxId);
    return this.serialize(async () => {
      this.fence();
      const now = Date.now();
      const row = await this.env.DB.prepare(
        "UPDATE outbox SET status = 'unknown', error = 'Worker stopped during send; check provider outcome before resending', updated_at = ? WHERE id = ? AND inbox_id = ? AND status = 'sending' AND updated_at < ? RETURNING id",
      )
        .bind(now, id, inboxId, now - 2 * 60_000)
        .first<{ id: string }>();
      if (row)
        console.error(
          JSON.stringify({ event: "outbound_attention_required", id, status: "unknown" }),
        );
    });
  }

  private checkIdentity(inboxId: string): void {
    if (!this.env.AGENTPOST_INBOX_COORDINATOR.idFromName(inboxId).equals(this.ctx.id)) {
      throw new Error("Inbox coordinator identity mismatch");
    }
  }
}

export function coordinator(env: Env, inboxId: string) {
  return env.AGENTPOST_INBOX_COORDINATOR.getByName(inboxId);
}

export async function deliver(env: Env, id: string): Promise<void> {
  const row = await env.DB.prepare("SELECT inbox_id FROM outbox WHERE id = ?")
    .bind(id)
    .first<{ inbox_id: string }>();
  if (row) await coordinator(env, row.inbox_id).deliver(id, row.inbox_id);
}
