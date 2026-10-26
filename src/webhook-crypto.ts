import { z } from "zod";
import { WebhookError, webhookEncryptionKey, webhookTarget } from "./webhook-policy";
import type { Env } from "./types";
const encoder = new TextEncoder();
const configSchema = z
  .object({ url: z.string().max(2048), secret: z.string().regex(/^whsec_[A-Za-z0-9+/]{43}=$/) })
  .strict();
export type WebhookConfig = z.output<typeof configSchema>;
const associatedData = (inbox: string, id: string) =>
  encoder.encode(`agentpost:webhook:v1:${inbox}:${id}`);
const base64 = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unbase64 = (value: string) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));

export async function createWebhookConfig(env: Env, inbox: string, url: string) {
  const target = webhookTarget(env, url);
  const key = await crypto.subtle.importKey("raw", webhookEncryptionKey(env), "AES-GCM", false, [
    "encrypt",
  ]);
  const id = crypto.randomUUID();
  const secret = `whsec_${base64(crypto.getRandomValues(new Uint8Array(32)))}`;
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const bytes = encoder.encode(JSON.stringify({ url: target.href, secret }));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: associatedData(inbox, id) },
    key,
    bytes,
  );
  return { id, secret, encrypted: `v1.${base64(nonce)}.${base64(encrypted)}` };
}

function encryptedParts(encrypted: string): [string, string] {
  if (encrypted.length > 8192) throw new Error("Invalid configuration");
  const parts = z
    .tuple([z.literal("v1"), z.string().min(1), z.string().min(1)])
    .parse(encrypted.split("."));
  return [parts[1], parts[2]];
}

export async function readWebhookConfig(
  env: Env,
  inbox: string,
  id: string,
  encrypted: string,
): Promise<WebhookConfig> {
  try {
    const [nonce, ciphertext] = encryptedParts(encrypted);
    const key = await crypto.subtle.importKey("raw", webhookEncryptionKey(env), "AES-GCM", false, [
      "decrypt",
    ]);
    const decoded = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unbase64(nonce), additionalData: associatedData(inbox, id) },
      key,
      unbase64(ciphertext),
    );
    return configSchema.parse(JSON.parse(new TextDecoder().decode(decoded)));
  } catch {
    throw new WebhookError(
      503,
      "Webhook configuration cannot be decrypted; inspect the encryption key and reconfigure",
    );
  }
}

export async function webhookSignature(
  secret: string,
  id: string,
  timestamp: string,
  body: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    unbase64(secret.slice(6)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${id}.${timestamp}.${body}`),
  );
  return `v1,${base64(signature)}`;
}
