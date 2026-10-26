import { z } from "zod";
import { hasUrlUserInfo } from "./transport-url";
import type { Env } from "./types";

export class WebhookError extends Error {
  constructor(
    public status: 400 | 404 | 409 | 503,
    message: string,
  ) {
    super(message);
  }
}
export const webhookInput = z.object({ url: z.string().min(1).max(2048) }).strict();

function publicHostname(hostname: string): boolean {
  if (!z.hostname().safeParse(hostname).success || !hostname.includes(".")) return false;
  if (/^[\d.]+$/.test(hostname)) return false;
  return !["localhost", "local", "internal", "invalid", "test", "onion", "arpa"].some(
    (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
  );
}

function httpsTarget(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WebhookError(400, "Invalid webhook URL");
  }
  if (
    [
      url.protocol !== "https:",
      Boolean(url.port),
      hasUrlUserInfo(url),
      Boolean(url.hash),
      !publicHostname(url.hostname),
    ].some(Boolean)
  )
    throw new WebhookError(
      400,
      "Webhook URL must use a public HTTPS hostname on port 443 without credentials or a fragment",
    );
  return url;
}

export function webhookTarget(env: Env, value: string): URL {
  const url = httpsTarget(value);
  let origins: string[];
  try {
    origins = z
      .array(z.string())
      .min(1)
      .max(32)
      .parse(JSON.parse(env.AGENTPOST_WEBHOOK_ALLOWED_ORIGINS ?? "[]"));
    for (const origin of origins) {
      if (httpsTarget(origin).origin !== origin) throw new Error("Origin required");
    }
  } catch {
    throw new WebhookError(
      503,
      "Configure AGENTPOST_WEBHOOK_ALLOWED_ORIGINS with trusted HTTPS origins before enabling webhooks",
    );
  }
  if (!origins.includes(url.origin))
    throw new WebhookError(400, "Webhook origin is not allowed by the operator");
  return url;
}

export function webhookEncryptionKey(env: Env): Uint8Array<ArrayBuffer> {
  const value = env.AGENTPOST_WEBHOOK_ENCRYPTION_KEY;
  if (!value || !/^[a-fA-F0-9]{64}$/.test(value))
    throw new WebhookError(503, "Configure a 32-byte hexadecimal AGENTPOST_WEBHOOK_ENCRYPTION_KEY");
  return Uint8Array.from(value.match(/../g)!, (hex) => Number.parseInt(hex, 16));
}
