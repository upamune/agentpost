import { McpServer, ProtocolError } from "@modelcontextprotocol/server";
import type { BaseContext } from "@modelcontextprotocol/server";
import { z } from "zod";
import { MailApiError, MailClient } from "./client";
import {
  eventDescriptors,
  eventPollPageSchema,
  eventPollResultSchema,
  eventQuerySchema,
} from "./event-schema";
import type { EventQuery, EventPollPage } from "./event-schema";
import { wait } from "./wait";

const EVENTS_DRAFT_COMMIT = "d5316be214be2e76e51462069c1d67e00a5a7619";
const retryAfterSchema = z.object({ retryAfterMs: z.number().int().min(1000).max(3_600_000) });
type EventPoller = (query: EventQuery, signal: AbortSignal) => Promise<EventPollPage>;
type StreamRequest = Pick<BaseContext["mcpReq"], "id" | "signal" | "notify">;
const apiFailures = new Map<
  number,
  { code: number; message: string; data?: Record<string, unknown> }
>([
  [401, { code: -32024, message: "Event subscription forbidden" }],
  [403, { code: -32024, message: "Event subscription forbidden" }],
  [404, { code: -32023, message: "Event type not found", data: { kind: "event" } }],
  [400, { code: -32602, message: "Invalid event subscription or cursor" }],
]);

function protocolError(error: unknown): ProtocolError {
  if (error instanceof ProtocolError) return error;
  if (error instanceof MailApiError) {
    if (error.status === 429)
      return new ProtocolError(-32603, "Event source rate limited", {
        retryAfterMs: error.retryAfterMs ?? 60_000,
      });
    const failure = apiFailures.get(error.status);
    if (failure) return new ProtocolError(failure.code, failure.message, failure.data);
  }
  return new ProtocolError(-32603, "Event source unavailable");
}

class EventStream {
  private cursor = "";
  private heartbeatAt = 0;
  private failures = 0;
  constructor(
    private readonly query: EventQuery,
    private readonly request: StreamRequest,
    private readonly poll: EventPoller,
  ) {}

  private send(method: string, params: Record<string, unknown>) {
    const { notify, id } = this.request;
    return notify({
      method,
      params: { ...params, _meta: { "io.modelcontextprotocol/subscriptionId": id } },
    });
  }

  private async heartbeat(): Promise<void> {
    if (Date.now() - this.heartbeatAt >= 15_000) {
      await this.send("notifications/events/heartbeat", { cursor: this.cursor });
      this.heartbeatAt = Date.now();
    }
  }

  private async deliver(page: EventPollPage): Promise<void> {
    for (let index = 0; index < page.events.length && !this.request.signal.aborted; index++) {
      const nextCursor = page.eventCursors[index];
      if (!nextCursor) throw new ProtocolError(-32603, "Event source omitted a replay cursor");
      await this.send("notifications/events/event", { ...page.events[index], cursor: nextCursor });
      this.cursor = nextCursor;
    }
  }

  private async backoff(failure: ProtocolError): Promise<void> {
    const retry = retryAfterSchema.safeParse(failure.data);
    const retryAt =
      Date.now() +
      (retry.success
        ? retry.data.retryAfterMs
        : Math.min(15_000, 1000 * 2 ** Math.min(this.failures++, 4)));
    const { signal } = this.request;
    while (!signal.aborted && Date.now() < retryAt) {
      await wait(Math.min(15_000, retryAt - Date.now()), signal);
      if (!signal.aborted) await this.heartbeat();
    }
  }

  private async handleFailure(error: unknown): Promise<boolean> {
    const failure = protocolError(error);
    if (error instanceof ProtocolError && error.code !== -32603) {
      await this.send("notifications/events/terminated", {
        error: { code: error.code, message: error.message },
      });
      return false;
    }
    await this.send("notifications/events/error", {
      error: { code: failure.code, message: "Event source unavailable" },
    });
    await this.heartbeat();
    await this.backoff(failure);
    return true;
  }

  private async nextPage(): Promise<EventPollPage | null> {
    const { signal } = this.request;
    while (!signal.aborted) {
      try {
        return await this.fetchPage();
      } catch (error) {
        if (signal.aborted || !(await this.handleFailure(error))) return null;
      }
    }
    return null;
  }

  private async fetchPage(): Promise<EventPollPage> {
    const page = await this.poll({ ...this.query, cursor: this.cursor }, this.request.signal);
    this.failures = 0;
    if (page.truncated) {
      this.cursor = page.startCursor;
      await this.send("notifications/events/active", { cursor: this.cursor, truncated: true });
    }
    return page;
  }

  async run(): Promise<{ _meta: Record<string, never> }> {
    const { signal } = this.request;
    let page = await this.poll(this.query, signal);
    this.cursor = page.startCursor;
    await this.send("notifications/events/active", {
      cursor: this.cursor,
      truncated: page.truncated,
    });
    this.heartbeatAt = Date.now();
    while (!signal.aborted) {
      await this.deliver(page);
      if (signal.aborted) break;
      this.cursor = page.cursor;
      await this.heartbeat();
      await wait(page.hasMore ? 0 : Math.max(1000, page.nextPollMs), signal);
      const next = await this.nextPage();
      if (!next) break;
      page = next;
    }
    return { _meta: {} };
  }
}

export function registerEventMethods(server: McpServer, client: MailClient): void {
  const capabilities = {
    events: { listChanged: false },
    extensions: {
      "io.modelcontextprotocol/events": { draft: EVENTS_DRAFT_COMMIT, delivery: ["poll", "push"] },
    },
  };
  server.server.registerCapabilities(capabilities);
  const poll = async (query: EventQuery, signal: AbortSignal) => {
    try {
      return eventPollPageSchema.parse(
        await client.call(
          "POST",
          "/v1/events/poll",
          query,
          undefined,
          AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        ),
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "mcp_event_poll_failed",
          status: error instanceof MailApiError ? error.status : undefined,
          reason: pollFailureReason(error),
        }),
      );
      throw protocolError(error);
    }
  };
  server.server.setRequestHandler(
    "events/list",
    {
      params: z.object({ cursor: z.string().optional() }).default({}),
      result: z.object({ events: z.array(z.record(z.string(), z.unknown())) }),
    },
    ({ cursor }) => {
      if (cursor !== undefined) throw new ProtocolError(-32602, "Event list has a single page");
      return { events: eventDescriptors };
    },
  );
  server.server.setRequestHandler(
    "events/poll",
    { params: eventQuerySchema, result: eventPollResultSchema },
    async (query, context) => eventPollResultSchema.parse(await poll(query, context.mcpReq.signal)),
  );
  server.server.setRequestHandler(
    "events/stream",
    {
      params: eventQuerySchema,
      result: z.object({ _meta: z.object({}) }),
    },
    (query, context) => new EventStream(query, context.mcpReq, poll).run(),
  );
}

function pollFailureReason(error: unknown) {
  if (error instanceof z.ZodError)
    return error.issues.map((issue) => ({ path: issue.path, code: issue.code }));
  if (error instanceof MailApiError) return "api_rejected";
  return error instanceof Error ? error.message : "unknown";
}
