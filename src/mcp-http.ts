import { MAX_MCP_REQUEST_BYTES } from "./attachment-policy";
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
  const authorization = request.headers.get("Authorization") ?? undefined;
  const principal = await authenticate(env, request);
  if (principal instanceof Response) return principal;
  const client = new MailClient({
    url: new URL(request.url).origin,
    token: authorization?.startsWith("Bearer ") ? authorization.slice(7) : "",
    fetch: async (url, init) => {
      const headers = new Headers(init.headers);
      const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
      if (assertion !== null) headers.set("Cf-Access-Jwt-Assertion", assertion);
      return app.fetch(new Request(url, { ...init, headers }), env, context);
    },
  });
  const handler = createMcpHandler(() => createMailServer(client), {
    maxRequestBodySize: MAX_MCP_REQUEST_BYTES,
    maxSubscriptions: 32,
    onerror: () => console.error(JSON.stringify({ event: "mcp_request_failed" })),
  });
  return handler.fetch(request);
}
