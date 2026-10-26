import { z } from "zod";
import { forwardingDestination } from "./forwarding-policy";
import type { MailClient } from "./client";

interface ForwardingArguments {
  values: { destination?: string; note?: string };
  positionals: string[];
}

export async function forwardingCommand(client: MailClient, args: ForwardingArguments) {
  const [, action, inbox, message] = args.positionals;
  const path =
    inbox === undefined ? "/v1/forwarding" : `/v1/inboxes/${z.uuid().parse(inbox)}/forwarding`;
  switch (action) {
    case "get":
      return client.call("GET", path);
    case "set":
      return client.call("PUT", path, setInput(inbox, args.values.destination));
    case "off":
      return client.call(
        "PUT",
        path,
        inbox === undefined ? { destination: null } : { mode: "off" },
      );
    default:
      return inboxForwardingCommand(client, path, inbox, message, action, args.values.note);
  }
}

function setInput(inbox: string | undefined, destination: string | undefined) {
  const target = forwardingDestination.parse(destination);
  return inbox === undefined ? { destination: target } : { mode: "custom", destination: target };
}

async function inboxForwardingCommand(
  client: MailClient,
  path: string,
  inbox: string | undefined,
  message: string | undefined,
  action: string | undefined,
  note: string | undefined,
) {
  if (inbox === undefined) throw new Error("This forwarding command requires INBOX_ID");
  switch (action) {
    case "inherit":
      return client.call("PUT", path, { mode: "inherit" });
    case "deliveries":
      return client.call("GET", `${path}/deliveries`);
    case "resolve":
      return client.call(
        "POST",
        `${path}/deliveries/${z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .parse(message)}/resolve`,
        {
          note: z
            .string()
            .min(1)
            .max(1000)
            .regex(/^[^\p{Cc}]+$/u)
            .parse(note),
        },
      );
    default:
      throw new Error("Unknown forwarding command. Use get|set|off|inherit|deliveries|resolve");
  }
}
