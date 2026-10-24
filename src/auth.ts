import { equalHash, sha256 } from "./common";
import type { Env } from "./types";

export interface Principal {
  admin: boolean;
  tokenHash: string;
  inboxId: string | null;
}

export async function authenticate(
  env: Env,
  authorization: string | undefined,
): Promise<Principal | Response> {
  if (
    !env.ADMIN_TOKEN ||
    !/^[a-zA-Z0-9_-]{32,256}$/.test(env.ADMIN_TOKEN) ||
    env.ADMIN_TOKEN === "replace-with-a-random-secret-at-least-32-characters"
  ) {
    return Response.json({ error: "Server authentication is not configured" }, { status: 503 });
  }
  const token = authorization?.match(/^Bearer ([a-zA-Z0-9_-]{32,256})$/)?.[1];
  if (!token) return Response.json({ error: "Bearer token required" }, { status: 401 });
  const [tokenHash, adminHash] = await Promise.all([sha256(token), sha256(env.ADMIN_TOKEN)]);
  if (equalHash(tokenHash, adminHash)) return { admin: true, tokenHash, inboxId: null };
  const inbox = await env.DB.prepare("SELECT id FROM inboxes WHERE token_hash = ? AND active = 1")
    .bind(tokenHash)
    .first<{ id: string }>();
  if (!inbox) return Response.json({ error: "Invalid token" }, { status: 401 });
  return { admin: false, tokenHash, inboxId: inbox.id };
}
