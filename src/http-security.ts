import { sha256 } from "./common";
import type { Env } from "./types";

export function secureResponse(request: Request, response: Response): Response {
  const secured = new Response(response.body, response);
  secured.headers.set("Cache-Control", "no-store");
  secured.headers.set("X-Content-Type-Options", "nosniff");
  secured.headers.set(
    "Content-Security-Policy",
    "default-src 'none'; frame-ancestors 'none'; sandbox",
  );
  secured.headers.set("Referrer-Policy", "no-referrer");
  secured.headers.set("X-Frame-Options", "DENY");
  if (new URL(request.url).protocol === "https:")
    secured.headers.set("Strict-Transport-Security", "max-age=31536000");
  return secured;
}

export async function enforceRateLimit(limiter: RateLimit, key: string): Promise<Response | null> {
  try {
    const { success } = await limiter.limit({ key });
    return success
      ? null
      : Response.json(
          { error: "Rate limit exceeded; wait before retrying" },
          { status: 429, headers: { "Retry-After": "60" } },
        );
  } catch {
    console.error(JSON.stringify({ event: "rate_limiter_unavailable" }));
    return Response.json({ error: "Rate limiter unavailable" }, { status: 503 });
  }
}

export async function guardHttpRequest(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  )
    return Response.json({ error: "HTTPS required" }, { status: 403 });
  const origin = request.headers.get("Origin");
  if (
    (origin !== null && origin !== url.origin) ||
    request.headers.get("Sec-Fetch-Site") === "cross-site"
  )
    return Response.json({ error: "Origin not allowed" }, { status: 403 });
  // Cloudflare supplies this header at the edge. Keep raw IPs out of limiter keys/logs.
  const peer = request.headers.get("CF-Connecting-IP") ?? "local";
  return enforceRateLimit(env.AGENTPOST_REQUEST_LIMITER, `http:${await sha256(peer)}`);
}
