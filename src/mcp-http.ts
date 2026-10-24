import { createMcpHandler } from "@modelcontextprotocol/server";
import app from "./api";
import { authenticate } from "./auth";
import { MailClient } from "./client";
import { createMailServer } from "./mcp-server";
import type { Env } from "./types";

export async function handleMcp(
  request: Request,
  env: Env,
  context: ExecutionContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) {
    return Response.json({ error: "Origin not allowed" }, { status: 403 });
  }
  const authorization = request.headers.get("Authorization") ?? undefined;
  const principal = await authenticate(env, authorization);
  if (principal instanceof Response) return principal;
  const client = new MailClient({
    url: new URL(request.url).origin,
    token: authorization!.slice(7),
    fetch: async (url, init) => app.fetch(new Request(url, init), env, context),
  });
  const handler = createMcpHandler(() => createMailServer(client), {
    maxRequestBodySize: 512 * 1024,
    maxSubscriptions: 32,
    onerror: () => console.error(JSON.stringify({ event: "mcp_request_failed" })),
  });
  const response = await handler.fetch(request);
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("X-Content-Type-Options", "nosniff");
  return response;
}
