import { z } from "zod";
import type { MailClient } from "./client";

interface WebhookArguments {
  values: { "webhook-url"?: string };
  positionals: string[];
}

export async function webhookCommand(client: MailClient, args: WebhookArguments) {
  const [, action, inbox] = args.positionals;
  const path = `/v1/inboxes/${z.uuid().parse(inbox)}/webhook`;
  switch (action) {
    case "get":
      return client.call("GET", path);
    case "set":
      return client.call("PUT", path, { url: z.url().parse(args.values["webhook-url"]) });
    case "delete":
      return client.call("DELETE", path);
    case "deliveries":
      return client.call("GET", `${path}/deliveries`);
    default:
      throw new Error("Unknown webhook command. Use webhook get|set|delete|deliveries INBOX_ID");
  }
}
