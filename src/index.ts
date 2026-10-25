import app from "./api";
import { oauthMetadata } from "./oauth-metadata";
import { parseMessage, receive } from "./inbound";
import { maintain } from "./maintenance";
import { deliver } from "./coordinator";
import { handleMcp } from "./mcp-http";
import { guardHttpRequest, secureResponse } from "./http-security";
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
  async queue(batch: MessageBatch<Job>, env: Env): Promise<void> {
    for (const message of batch.messages) await handleQueueMessage(message, env);
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await maintain(env);
  },
} satisfies ExportedHandler<Env, Job>;

async function handleQueueMessage(message: Message<Job>, env: Env): Promise<void> {
  try {
    if (message.body.kind === "outbound") await deliver(env, message.body.id);
    else await parseMessage(env, message.body.id);
    message.ack();
  } catch {
    console.error(
      JSON.stringify({
        event: "job_failed",
        kind: message.body.kind,
        id: message.body.id,
        attempts: message.attempts,
      }),
    );
    if (message.body.kind === "inbound" && message.attempts >= 5) {
      await env.DB.prepare(
        "UPDATE messages SET status = 'failed', error = 'Parsing failed; original MIME retained' WHERE id = ? AND status != 'ready'",
      )
        .bind(message.body.id)
        .run();
    }
    message.retry({ delaySeconds: Math.min(300, 30 * 2 ** (message.attempts - 1)) });
  }
}
