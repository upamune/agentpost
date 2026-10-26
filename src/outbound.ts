import { z } from "zod";
import { prepareAttachments } from "./attachments";
import { AttachmentError } from "./attachment-policy";
import type { Env, Outbox, SendPayload } from "./types";

const providerResponse = z.object({
  success: z.boolean(),
  result: z.unknown().optional(),
});

export type SendResult =
  | { status: "accepted"; result: string }
  | { status: "retry"; error: string; delay: number }
  | { status: "failed" | "unknown"; error: string };

function providerRetryDelay(retryAfter: string | null): number {
  const seconds = retryAfter ? Number(retryAfter) : NaN;
  const dateSeconds = retryAfter ? (Date.parse(retryAfter) - Date.now()) / 1000 : NaN;
  const delay = Number.isFinite(seconds)
    ? seconds
    : Number.isFinite(dateSeconds)
      ? dateSeconds
      : 60;
  return Math.min(3600, Math.max(30, delay));
}

async function providerAcceptance(response: Response): Promise<SendResult> {
  try {
    const parsed = providerResponse.safeParse(await response.json());
    if (parsed.success && parsed.data.success)
      return { status: "accepted", result: JSON.stringify(parsed.data.result ?? null) };
  } catch {
    // A truncated success response can follow a successful send.
  }
  return {
    status: "unknown",
    error: "Unrecognized provider response; check outcome before resending",
  };
}

export async function cloudflareSend(
  env: Env,
  payload: SendPayload,
  request: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<SendResult> {
  const credentials = sendingCredentials(env);
  if (!credentials) {
    return { status: "failed", error: "Email Sending credentials are not configured" };
  }
  let response: Response;
  try {
    response = await request(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(credentials.accountId)}/email/sending/send`,
      {
        method: "POST",
        redirect: "manual",
        headers: {
          Authorization: `Bearer ${credentials.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(20_000),
      },
    );
  } catch {
    // Cloudflare has no documented send idempotency contract. Never blindly resend.
    return {
      status: "unknown",
      error: "Provider connection failed; delivery outcome must be checked before resending",
    };
  }
  if (response.status === 429) {
    return {
      status: "retry",
      error: "Provider rate limit",
      delay: providerRetryDelay(response.headers.get("retry-after")),
    };
  }
  if ([400, 401, 403, 404, 413, 422].includes(response.status)) {
    return { status: "failed", error: `Provider rejected request (HTTP ${response.status})` };
  }
  if (!response.ok) {
    return {
      status: "unknown",
      error: `Provider returned HTTP ${response.status}; check outcome before resending`,
    };
  }
  return providerAcceptance(response);
}

function sendingCredentials(env: Env) {
  if (!env.AGENTPOST_CF_ACCOUNT_ID || !env.AGENTPOST_CF_EMAIL_API_TOKEN) return null;
  return { accountId: env.AGENTPOST_CF_ACCOUNT_ID, token: env.AGENTPOST_CF_EMAIL_API_TOKEN };
}

// Called only inside InboxCoordinator's serialized operation. The synchronous fence
// immediately before sender checks DO ownership after the final external await.
export async function processOutbound(
  env: Env,
  id: string,
  inboxId: string,
  beforeDispatch: () => void,
  sender = cloudflareSend,
): Promise<void> {
  const now = Date.now();
  // A single conditional write claims the job, even when Queue delivers duplicates.
  const row = await env.DB.prepare(
    "UPDATE outbox SET status = 'sending', attempts = attempts + 1, updated_at = ? WHERE id = ? AND inbox_id = ? AND status = 'pending' AND available_at <= ? RETURNING *",
  )
    .bind(now, id, inboxId, now)
    .first<Outbox>();
  if (!row) return;
  const inbox = await env.DB.prepare("SELECT active FROM inboxes WHERE id = ?")
    .bind(row.inbox_id)
    .first<{ active: number }>();
  let result: SendResult;
  if (inbox?.active) {
    result = await dispatchPrepared(env, row, beforeDispatch, sender);
  } else {
    result = { status: "failed", error: "Inbox is disabled" };
  }
  await settleSend(env, id, row.attempts, result);
}

async function settleSend(
  env: Env,
  id: string,
  attempts: number,
  result: SendResult,
): Promise<void> {
  if (result.status === "retry" && attempts < 8) {
    const delay = Math.max(result.delay, Math.min(3600, 30 * 2 ** (attempts - 1)));
    await env.DB.prepare(
      "UPDATE outbox SET status = 'pending', available_at = ?, updated_at = ?, error = ? WHERE id = ? AND status = 'sending'",
    )
      .bind(Date.now() + delay * 1000, Date.now(), result.error, id)
      .run();
    return;
  }
  const status = result.status === "retry" ? "failed" : result.status;
  const fields = providerOutcomeFields(result);
  await env.DB.prepare(
    "UPDATE outbox SET status = ?, provider_result = ?, error = ?, updated_at = ? WHERE id = ? AND status = 'sending'",
  )
    .bind(status, fields.providerResult, fields.error, Date.now(), id)
    .run();
  if (status === "unknown" || status === "failed") {
    console.error(JSON.stringify({ event: "outbound_attention_required", id, status }));
  }
}

function providerOutcomeFields(result: SendResult) {
  if (result.status === "accepted") return { providerResult: result.result, error: null };
  return { providerResult: null, error: result.error };
}

async function dispatchPrepared(
  env: Env,
  row: Outbox,
  beforeDispatch: () => void,
  sender: typeof cloudflareSend,
): Promise<SendResult> {
  let payload: SendPayload;
  try {
    payload = await prepareAttachments(env, row.inbox_id, JSON.parse(row.payload));
  } catch (error) {
    if (error instanceof AttachmentError) return { status: "failed", error: error.message };
    return {
      status: "retry",
      error: "Attachment storage unavailable before dispatch; no provider request was made",
      delay: 30,
    };
  }
  beforeDispatch();
  // No await between the ownership fence and starting the provider request.
  return sender(env, payload);
}
