import { readBounded } from "./common";
import { isHttpsOrLoopbackHttp } from "./transport-url";

// A paged outbox can contain 100 request bodies of up to 512 KiB each.
const MAX_JSON_RESPONSE_BYTES = 64 * 1024 * 1024;

function retryDelay(response: Response): number | undefined {
  if (response.status !== 429) return undefined;
  const value = response.headers.get("Retry-After");
  const seconds = value && /^\d+$/.test(value) ? Number(value) : NaN;
  const delay = Number.isFinite(seconds)
    ? seconds * 1000
    : value
      ? Date.parse(value) - Date.now()
      : NaN;
  return Math.min(3_600_000, Math.max(1000, Number.isFinite(delay) ? delay : 60_000));
}
export interface MailClientOptions {
  url: string;
  token: string;
  fetch?: (url: URL, init: RequestInit) => Promise<Response>;
}

export class MailApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public retryAfterMs?: number,
  ) {
    super(message);
  }
}

export class MailClient {
  private readonly url: URL;
  private readonly token: string;
  private readonly request: (url: URL, init: RequestInit) => Promise<Response>;

  constructor(options: MailClientOptions) {
    this.url = new URL(options.url);
    if (this.url.username || this.url.password || this.url.search || this.url.hash) {
      throw new Error(
        "AGENTPOST_API_URL must not contain credentials, query parameters, or a fragment",
      );
    }
    if (!isHttpsOrLoopbackHttp(this.url)) {
      throw new Error("AGENTPOST_API_URL must use HTTPS (HTTP is allowed on localhost)");
    }
    this.token = options.token;
    this.request = options.fetch ?? fetch;
  }

  private target(path: string): URL {
    const target = new URL(path, this.url);
    if (
      !path.startsWith("/v1/") ||
      path.includes("\\") ||
      target.origin !== this.url.origin ||
      !target.pathname.startsWith("/v1/") ||
      target.username ||
      target.password ||
      target.hash
    )
      throw new Error("Mail API path must stay within the configured origin and /v1/");
    return target;
  }

  async response(
    method: string,
    path: string,
    body?: unknown,
    key?: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    const response = await this.request(this.target(path), {
      method,
      redirect: "manual",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
        : AbortSignal.timeout(30_000),
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      // Error bodies can reflect credentials or contain hostile terminal/agent instructions.
      void response.body?.cancel().catch(() => {});
      throw new MailApiError(
        response.status,
        `Mail API HTTP ${response.status}`,
        retryDelay(response),
      );
    }
    return response;
  }

  async call(
    method: string,
    path: string,
    body?: unknown,
    key?: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const response = await this.response(method, path, body, key, signal);
    try {
      const declared = response.headers.get("Content-Length");
      if (declared && /^\d+$/.test(declared) && Number(declared) > MAX_JSON_RESPONSE_BYTES) {
        void response.body?.cancel().catch(() => {});
        throw new Error("Oversized response");
      }
      const bytes = response.body
        ? await readBounded(response.body, MAX_JSON_RESPONSE_BYTES)
        : new ArrayBuffer(0);
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      // Parse and stream failures may include reflected credentials or hostile response text.
      throw new Error("Mail API returned an invalid or oversized JSON response");
    }
  }
}
