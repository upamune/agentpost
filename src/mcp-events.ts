import { McpServer, ProtocolError } from "@modelcontextprotocol/server";
import { z } from "zod";
import { MailApiError, MailClient } from "./client";
import {
  eventDescriptors,
  eventPollPageSchema,
  eventPollResultSchema,
  eventQuerySchema,
} from "./event-schema";
import type { EventQuery } from "./event-schema";
import { wait } from "./wait";

const EVENTS_DRAFT_COMMIT = "d5316be214be2e76e51462069c1d67e00a5a7619";

function protocolError(error: unknown): ProtocolError {
  if (error instanceof MailApiError) {
    if (error.status === 401 || error.status === 403)
      return new ProtocolError(-32024, "Event subscription forbidden");
    if (error.status === 404)
      return new ProtocolError(-32023, "Event type not found", { kind: "event" });
    if (error.status === 400)
      return new ProtocolError(-32602, "Invalid event subscription or cursor");
  }
  return new ProtocolError(-32603, "Event source unavailable");
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
          reason:
            error instanceof z.ZodError
              ? error.issues.map((issue) => ({ path: issue.path, code: issue.code }))
              : error instanceof MailApiError
                ? "api_rejected"
                : error instanceof Error
                  ? error.message
                  : "unknown",
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
    async (query, context) => {
      const { signal, id, notify } = context.mcpReq;
      const meta = { "io.modelcontextprotocol/subscriptionId": id };
      let page = await poll(query, signal);
      let cursor = page.startCursor;
      const send = (method: string, params: Record<string, unknown>) =>
        notify({ method, params: { ...params, _meta: meta } });
      await send("notifications/events/active", { cursor, truncated: page.truncated });
      let heartbeatAt = Date.now();
      let failures = 0;
      while (!signal.aborted) {
        for (let index = 0; index < page.events.length && !signal.aborted; index++) {
          const nextCursor = page.eventCursors[index];
          if (!nextCursor) throw new ProtocolError(-32603, "Event source omitted a replay cursor");
          await send("notifications/events/event", { ...page.events[index], cursor: nextCursor });
          cursor = nextCursor;
        }
        if (signal.aborted) break;
        cursor = page.cursor;
        if (Date.now() - heartbeatAt >= 15_000) {
          await send("notifications/events/heartbeat", { cursor });
          heartbeatAt = Date.now();
        }
        await wait(page.hasMore ? 0 : Math.max(1000, page.nextPollMs), signal);
        while (!signal.aborted) {
          try {
            page = await poll({ ...query, cursor }, signal);
            failures = 0;
            if (page.truncated) {
              cursor = page.startCursor;
              await send("notifications/events/active", { cursor, truncated: true });
            }
            break;
          } catch (error) {
            if (signal.aborted) break;
            const failure = protocolError(error);
            if (error instanceof ProtocolError && error.code !== -32603) {
              await send("notifications/events/terminated", {
                error: { code: error.code, message: error.message },
              });
              return { _meta: {} };
            }
            await send("notifications/events/error", {
              error: { code: failure.code, message: "Event source unavailable" },
            });
            if (Date.now() - heartbeatAt >= 15_000) {
              await send("notifications/events/heartbeat", { cursor });
              heartbeatAt = Date.now();
            }
            await wait(Math.min(15_000, 1000 * 2 ** Math.min(failures++, 4)), signal);
          }
        }
      }
      return { _meta: {} };
    },
  );
}
