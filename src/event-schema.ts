import { z } from "zod";

export const EVENT_NAMES = ["message.received", "message.send_status_changed"] as const;
const eventArgumentsSchema = z.object({ inbox_id: z.uuid().optional() }).strict();
export const eventQuerySchema = z
  .object({
    name: z.string().min(1),
    arguments: eventArgumentsSchema.default({}),
    cursor: z.string().max(2048).nullable().optional(),
    maxAgeMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    maxEvents: z.number().int().min(1).max(100).default(25),
  })
  .strict();
const eventOccurrenceSchema = z.object({
  eventId: z.string(),
  name: z.enum(EVENT_NAMES),
  timestamp: z.iso.datetime(),
  data: z.record(z.string(), z.unknown()),
});
export const eventPollResultSchema = z.object({
  events: z.array(eventOccurrenceSchema),
  cursor: z.string(),
  truncated: z.boolean(),
  hasMore: z.boolean(),
  nextPollMs: z.number().int().positive(),
});
export const eventPollPageSchema = eventPollResultSchema.extend({
  startCursor: z.string(),
  eventCursors: z.array(z.string()),
});

export type EventQuery = z.output<typeof eventQuerySchema>;
export type EventPollPage = z.output<typeof eventPollPageSchema>;

export const eventDescriptors = EVENT_NAMES.map((name) => ({
  name,
  description:
    name === "message.received"
      ? "A received email has been durably stored and parsed. Metadata only; fetch the message separately."
      : "A send changed to accepted, failed, or unknown. Accepted is provider acceptance, not confirmed recipient delivery.",
  delivery: ["poll", "push"],
  inputSchema: z.toJSONSchema(eventArgumentsSchema),
  payloadSchema: z.toJSONSchema(
    name === "message.received"
      ? z.object({ inbox_id: z.uuid(), message_id: z.string() })
      : z.object({
          inbox_id: z.uuid(),
          send_id: z.uuid(),
          status: z.enum(["accepted", "failed", "unknown"]),
        }),
  ),
}));
