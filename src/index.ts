import app from "./api";
import { oauthMetadata } from "./oauth-metadata";
import { parseMessage, receive } from "./inbound";
import { publishMessageWebhooks } from "./webhook-store";
import { deliverWebhook } from "./webhooks";
import { maintain } from "./maintenance";
import { deliver } from "./coordinator";
import { handleMcp } from "./mcp-http";
import { guardHttpRequest, secureResponse } from "./http-security";
import { parseJob } from "./queue-jobs";
import type { Env, Job } from "./types";

export { InboxCoordinator } from "./coordinator";

export default {
  async fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
    try {
      const rejected = await guardHttpRequest(request, env);
      const response =
        rejected ??
        oauthMetadata(request, env) ??
        (await (new URL(request.url).pathname === "/mcp"
          ? handleMcp(request, env, context)
          : app.fetch(request, env, context)));
      return secureResponse(request, response);
    } catch {
      console.error(JSON.stringify({ event: "http_request_failed" }));
      return secureResponse(request, Response.json({ error: "Internal error" }, { status: 500 }));
    }
  },
  email: receive,
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    for (const message of batch.messages) await handleQueueMessage(message, env);
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await maintain(env);
  },
} satisfies ExportedHandler<Env, Job>;

async function handleQueueMessage(message: Message<unknown>, env: Env): Promise<void> {
  const job = parseJob(message.body);
  try {
    if (!job) throw new Error("Invalid queue job");
    await dispatchJob(env, job);
    message.ack();
  } catch {
    logJobFailure(message, job);
    await recordParsingFailure(env, job, message.attempts);
    message.retry({ delaySeconds: Math.min(300, 30 * 2 ** (message.attempts - 1)) });
  }
}

function logJobFailure(message: Message<unknown>, job: Job | null): void {
  console.error(
    JSON.stringify({
      event: "job_failed",
      kind: job?.kind ?? "invalid",
      id: job?.id ?? message.id,
      attempts: message.attempts,
    }),
  );
}

async function recordParsingFailure(env: Env, job: Job | null, attempts: number): Promise<void> {
  if (job?.kind !== "inbound" || attempts < 5) return;
  try {
    await env.DB.prepare(
      "UPDATE messages SET status = 'failed', error = 'Parsing failed; original MIME retained' WHERE id = ? AND status != 'ready'",
    )
      .bind(job.id)
      .run();
  } catch {
    // A failed attention write must not prevent later items from being handled.
    console.error(JSON.stringify({ event: "job_attention_write_failed", id: job.id }));
  }
}

async function dispatchJob(env: Env, job: Job): Promise<void> {
  if (job.kind === "outbound") return deliver(env, job.id);
  if (job.kind === "webhook") return deliverWebhook(env, job.id);
  await parseMessage(env, job.id);
  await publishMessageWebhooks(env, job.id);
}
