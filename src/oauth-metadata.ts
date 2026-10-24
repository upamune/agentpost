import { authConfiguration } from "./auth-config";
import type { Env } from "./types";

export function oauthChallenge(env: Env): string {
  const config = authConfiguration(env);
  return config.oauth
    ? `Bearer resource_metadata="${new URL("/.well-known/oauth-protected-resource/mcp", config.oauth.resource).href}"`
    : "Bearer";
}

export function isOAuthMetadataPath(path: string): boolean {
  return (
    path === "/.well-known/oauth-protected-resource/mcp" ||
    path === "/.well-known/oauth-protected-resource"
  );
}

export function oauthMetadata(request: Request, env: Env): Response | undefined {
  if (!isOAuthMetadataPath(new URL(request.url).pathname)) return;
  let config;
  try {
    config = authConfiguration(env);
  } catch {
    return Response.json({ error: "Server authentication is not configured" }, { status: 503 });
  }
  if (!config.oauth) return Response.json({ error: "OAuth is disabled" }, { status: 404 });
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  };
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response(null, {
      status: 405,
      headers: { ...headers, Allow: "GET, HEAD, OPTIONS" },
    });
  const response = Response.json(
    {
      resource: config.oauth.resource,
      authorization_servers: [config.oauth.authorizationServer],
      resource_name: "agentpost",
      bearer_methods_supported: ["header"],
    },
    { headers },
  );
  return request.method === "HEAD" ? new Response(null, response) : response;
}
