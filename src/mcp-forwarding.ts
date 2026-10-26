import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { MailClient } from "./client";
import { globalForwardingInput, inboxForwardingInput } from "./forwarding-policy";
import { mailToolOutput } from "./mcp-output";

export function registerForwardingTools(server: McpServer, client: MailClient): void {
  const inbox = { inbox_id: z.uuid() };
  const path = (id: string) => `/v1/inboxes/${encodeURIComponent(id)}/forwarding`;
  server.registerTool(
    "get_global_forwarding",
    {
      description:
        "Read the global incoming-email forwarding default. Administrator only; destination addresses are private operator configuration.",
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true },
    },
    () => mailToolOutput(() => client.call("GET", "/v1/forwarding")),
  );
  server.registerTool(
    "set_global_forwarding",
    {
      description:
        "Set the default destination for future incoming mail, or null to turn the global default off. Administrator only. Requires explicit user authorization to disclose received mail to this operator-allowed, Cloudflare-verified address. Per-inbox custom/off overrides remain in force. Does not replay stored mail or recall admitted forwards.",
      inputSchema: globalForwardingInput,
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    (input) => mailToolOutput(() => client.call("PUT", "/v1/forwarding", input)),
  );
  server.registerTool(
    "get_inbox_forwarding",
    {
      description:
        "Read this inbox's forwarding override and effective destination. Administrator only.",
      inputSchema: z.object(inbox).strict(),
      annotations: { readOnlyHint: true },
    },
    ({ inbox_id }) => mailToolOutput(() => client.call("GET", path(inbox_id))),
  );
  server.registerTool(
    "set_inbox_forwarding",
    {
      description:
        "Set future-mail forwarding for one inbox: inherit the global default, off, or custom destination. Administrator only; a custom destination needs explicit user authorization, operator allowlisting and Cloudflare verification. No stored mail is replayed. Previously admitted forwards may finish.",
      inputSchema: z.object({ ...inbox, configuration: inboxForwardingInput }).strict(),
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    ({ inbox_id, configuration }) =>
      mailToolOutput(() => client.call("PUT", path(inbox_id), configuration)),
  );
  server.registerTool(
    "list_forwarding_deliveries",
    {
      description:
        "Read the latest 50 incoming-mail forwarding outcomes for one inbox. Administrator only. Accepted means native provider acceptance, not recipient delivery; unknown outcomes are never automatically retried.",
      inputSchema: z.object(inbox).strict(),
      annotations: { readOnlyHint: true },
    },
    ({ inbox_id }) => mailToolOutput(() => client.call("GET", `${path(inbox_id)}/deliveries`)),
  );
  server.registerTool(
    "resolve_forwarding",
    {
      description:
        "Acknowledge an investigated blocked/unknown forward with an operator evidence note. Administrator only. Clears health attention without changing its recorded outcome or resending any mail.",
      inputSchema: z
        .object({
          ...inbox,
          message_id: z.string().regex(/^[a-f0-9]{64}$/),
          note: z
            .string()
            .min(1)
            .max(1000)
            .regex(/^[^\p{Cc}]+$/u),
        })
        .strict(),
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    ({ inbox_id, message_id, note }) =>
      mailToolOutput(() =>
        client.call("POST", `${path(inbox_id)}/deliveries/${message_id}/resolve`, { note }),
      ),
  );
}
