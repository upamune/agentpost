export interface MailClientOptions {
  url: string;
  token: string;
  fetch?: (url: URL, init: RequestInit) => Promise<Response>;
}

export class MailApiError extends Error {
  constructor(
    public status: number,
    message: string,
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
      throw new Error("MAIL_API_URL must not contain credentials, query parameters, or a fragment");
    }
    if (
      this.url.protocol !== "https:" &&
      !(
        this.url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(this.url.hostname)
      )
    ) {
      throw new Error("MAIL_API_URL must use HTTPS (HTTP is allowed on localhost)");
    }
    this.token = options.token;
    this.request = options.fetch ?? fetch;
  }

  async response(
    method: string,
    path: string,
    body?: unknown,
    key?: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    const response = await this.request(new URL(path, this.url), {
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
    if (!response.ok)
      throw new MailApiError(
        response.status,
        `Mail API HTTP ${response.status}: ${(await response.text()).slice(0, 2000)}`,
      );
    return response;
  }

  async call(
    method: string,
    path: string,
    body?: unknown,
    key?: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return (await this.response(method, path, body, key, signal)).json();
  }
}
