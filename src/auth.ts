import { equalHash, sha256 } from "./common";
import { authConfiguration } from "./auth-config";
import { authenticateAccess } from "./access";
import { oauthChallenge } from "./oauth-metadata";
import type { Env, Inbox } from "./types";

export interface Principal {
  admin: boolean;
  credential: "token" | "oauth";
  tokenHash: string;
  inboxId: string | null;
  ownerId?: string;
}

export function canAccessInbox(principal: Principal, inbox: Inbox): boolean {
  return (
    principal.admin ||
    (Boolean(inbox.active) &&
      (principal.credential === "token"
        ? principal.inboxId === inbox.id
        : Boolean(inbox.owner_id && inbox.owner_id === principal.ownerId)))
  );
}

function denyAuthentication(env: Env): Response {
  return Response.json(
    { error: "Authentication required or invalid credentials" },
    { status: 401, headers: { "WWW-Authenticate": oauthChallenge(env) } },
  );
}

async function authenticateToken(env: Env, request: Request): Promise<Principal | Response> {
  const token = request.headers
    .get("Authorization")
    ?.match(/^Bearer ([a-zA-Z0-9_-]{32,256})$/)?.[1];
  if (!token) return denyAuthentication(env);
  const [tokenHash, adminHash] = await Promise.all([
    sha256(token),
    sha256(env.AGENTPOST_ADMIN_TOKEN!),
  ]);
  if (equalHash(tokenHash, adminHash))
    return { admin: true, credential: "token", tokenHash, inboxId: null };
  const inbox = await env.DB.prepare("SELECT id FROM inboxes WHERE token_hash = ? AND active = 1")
    .bind(tokenHash)
    .first<{ id: string }>();
  if (!inbox) return denyAuthentication(env);
  return { admin: false, credential: "token", tokenHash, inboxId: inbox.id };
}

export async function authenticate(env: Env, request: Request): Promise<Principal | Response> {
  let config;
  try {
    config = authConfiguration(env);
  } catch {
    return Response.json({ error: "Server authentication is not configured" }, { status: 503 });
  }
  const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
  if (config.oauth && assertion !== null) {
    // Explicit OAuth credentials never fall back to a static token on failure.
    const result = await authenticateAccess(config.oauth, assertion);
    if (result instanceof Response && result.status === 401)
      result.headers.set("WWW-Authenticate", oauthChallenge(env));
    return result;
  }
  if (config.mode === "oauth") return denyAuthentication(env);
  return authenticateToken(env, request);
}
