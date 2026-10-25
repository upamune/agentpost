import { z } from "zod";
import { hasUrlExtras } from "./transport-url";
import type { Env } from "./types";

const secret = z
  .string()
  .min(32)
  .max(256)
  .regex(/^[a-zA-Z0-9_-]+$/)
  .refine((value) => value !== "replace-with-a-random-secret-at-least-32-characters");
const modes = z.enum(["token", "oauth", "both"]);
const grantsSchema = z.record(
  z.string().regex(/^(user|service):[a-zA-Z0-9_.@-]{1,256}$/),
  z.enum(["admin", "agent"]),
);

function validSecret(value: unknown): value is string {
  return secret.safeParse(value).success;
}

function httpsUrl(value: string | undefined): URL {
  if (!value || /[\s\p{Cc}]/u.test(value)) throw new Error("Invalid authentication URL");
  const url = new URL(value);
  if (url.protocol !== "https:" || hasUrlExtras(url)) throw new Error("Invalid authentication URL");
  return url;
}

type AuthSettings = Pick<
  Env,
  | "AGENTPOST_AUTH_MODE"
  | "AGENTPOST_ADMIN_TOKEN"
  | "AGENTPOST_CURSOR_KEY"
  | "AGENTPOST_ACCESS_TEAM_DOMAIN"
  | "AGENTPOST_ACCESS_AUD"
  | "AGENTPOST_ACCESS_PRINCIPALS"
  | "AGENTPOST_OAUTH_RESOURCE_URL"
  | "AGENTPOST_OAUTH_AUTHORIZATION_SERVER"
>;

function oauthConfiguration(env: AuthSettings) {
  const issuer = httpsUrl(env.AGENTPOST_ACCESS_TEAM_DOMAIN);
  if (
    !/^[a-z0-9][a-z0-9-]*\.cloudflareaccess\.com$/.test(issuer.hostname) ||
    issuer.port ||
    issuer.pathname !== "/"
  )
    throw new Error("Invalid Access team domain");
  const resource = httpsUrl(env.AGENTPOST_OAUTH_RESOURCE_URL);
  if (resource.pathname !== "/mcp") throw new Error("OAuth resource must end in /mcp");
  httpsUrl(env.AGENTPOST_OAUTH_AUTHORIZATION_SERVER);
  const audience = z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(env.AGENTPOST_ACCESS_AUD);
  const grantText = z.string().max(16_384).parse(env.AGENTPOST_ACCESS_PRINCIPALS);
  const grants = grantsSchema.parse(JSON.parse(grantText));
  return {
    issuer: issuer.origin,
    audience,
    resource: resource.href,
    authorizationServer: env.AGENTPOST_OAUTH_AUTHORIZATION_SERVER!,
    grants,
  };
}

export function authConfiguration(env: AuthSettings) {
  const mode = modes.parse(env.AGENTPOST_AUTH_MODE ?? "token");
  if (mode !== "oauth" && !validSecret(env.AGENTPOST_ADMIN_TOKEN))
    throw new Error("Token authentication is not configured");
  const cursorKey = cursorEncryptionKey(env, mode);
  return { mode, cursorKey, oauth: mode === "token" ? null : oauthConfiguration(env) };
}

function cursorEncryptionKey(env: AuthSettings, mode: z.output<typeof modes>): string {
  const key =
    env.AGENTPOST_CURSOR_KEY ?? (mode === "token" ? env.AGENTPOST_ADMIN_TOKEN : undefined);
  if (!validSecret(key)) throw new Error("Cursor encryption is not configured");
  return key;
}
