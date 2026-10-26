import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { MailClient } from "./client";
import { mailToolOutput } from "./mcp-output";

export function registerWebhookTools(server: McpServer, client: MailClient): void {
  const inbox = { inbox_id: z.uuid() };
  const path = (id: string) => `/v1/inboxes/${encodeURIComponent(id)}/webhook`;
  server.registerTool(
    "get_webhook",
    {
      description:
        "Read this inbox's received-email webhook configuration without its secret. Requires access to this inbox. Webhooks are disabled until the operator configures an encryption key, allowed HTTPS origins and a dedicated queue.",
      inputSchema: z.object(inbox).strict(),
      annotations: { readOnlyHint: true },
    },
    ({ inbox_id }) => mailToolOutput(() => client.call("GET", path(inbox_id))),
  );
  server.registerTool(
    "set_webhook",
    {
      description:
        "Configure one received-email webhook for this inbox at a user-authorized, operator-allowed public HTTPS URL. Replaces configuration, rotates its signing secret, and cancels old pending deliveries. Returns the secret ONCE: store privately and configure the receiver; do not expose it in chat. Notifications contain IDs only. Do not automatically retry after a timeout: first inspect get_webhook, since replacement rotates the secret again.",
      inputSchema: z.object({ ...inbox, url: z.url().max(2048) }).strict(),
      annotations: { idempotentHint: false, destructiveHint: true },
    },
    ({ inbox_id, url }) => mailToolOutput(() => client.call("PUT", path(inbox_id), { url })),
  );
  server.registerTool(
    "delete_webhook",
    {
      description:
        "Disable this inbox's received-email webhook and cancel pending deliveries. A request already initiated cannot be recalled. Requires authorization to stop notifications for this inbox.",
      inputSchema: z.object(inbox).strict(),
      annotations: { idempotentHint: true, destructiveHint: true },
    },
    ({ inbox_id }) => mailToolOutput(() => client.call("DELETE", path(inbox_id))),
  );
  server.registerTool(
    "list_webhook_deliveries",
    {
      description:
        "Read the latest 50 webhook delivery states for this inbox. Delivery is at least once, with at most 8 attempts per notification. A successful webhook response confirms endpoint acceptance, not that an agent processed the mail. Fetch mail through get_message and deduplicate webhook-id at the receiver.",
      inputSchema: z.object(inbox).strict(),
      annotations: { readOnlyHint: true },
    },
    ({ inbox_id }) => mailToolOutput(() => client.call("GET", `${path(inbox_id)}/deliveries`)),
  );
}
