import { parseArgs } from "node:util";
import { open, readFile } from "node:fs/promises";
import { z } from "zod";
import { MAX_MAIL_BYTES, readBounded } from "./common";
import { MailClient } from "./client";
import { inboxInputSchema } from "./inbox-schema";
import { watchEvents } from "./watch";

export function parseCliArgs(args: string[]) {
  return parseArgs({
    args,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean" },
      url: { type: "string" },
      label: { type: "string" },
      "local-part": { type: "string" },
      limit: { type: "string" },
      offset: { type: "string" },
      cursor: { type: "string" },
      "cursor-file": { type: "string" },
      name: { type: "string" },
      inbox: { type: "string" },
      "max-age-ms": { type: "string" },
      to: { type: "string", multiple: true },
      subject: { type: "string" },
      text: { type: "string" },
      "text-file": { type: "string" },
      "html-file": { type: "string" },
      "idempotency-key": { type: "string" },
      output: { type: "string" },
      outcome: { type: "string" },
      note: { type: "string" },
      strict: { type: "boolean" },
    },
  });
}
type Arguments = ReturnType<typeof parseCliArgs>;
type Values = Arguments["values"];

export function required(value: string | undefined, label: string): string {
  if (!value) throw new Error(`${label} is required. Use --help for usage.`);
  return value;
}
const inboxId = (value: string | undefined) => z.uuid().parse(required(value, "INBOX_ID"));
const path = (value: string | undefined) => `/v1/inboxes/${inboxId(value)}`;
const encoded = (value: string | undefined, label: string) =>
  encodeURIComponent(required(value, label));
const pagination = (values: Values) =>
  new URLSearchParams({ limit: values.limit ?? "25", offset: values.offset ?? "0" });

async function mailBody(values: Values) {
  if (values.text !== undefined && values["text-file"] !== undefined)
    throw new Error("Choose --text or --text-file");
  return {
    text: values["text-file"]
      ? await readFile(values["text-file"], "utf8")
      : required(values.text, "--text or --text-file"),
    ...(values["html-file"] ? { html: await readFile(values["html-file"], "utf8") } : {}),
  };
}

async function inboxCommand(
  client: MailClient,
  { values, positionals: [, action, id] }: Arguments,
) {
  switch (action) {
    case "create":
      return client.call(
        "POST",
        "/v1/inboxes",
        inboxInputSchema.parse({ label: values.label ?? "", local_part: values["local-part"] }),
      );
    case "list":
      return client.call("GET", `/v1/inboxes?${pagination(values)}`);
    default:
      return existingInboxCommand(client, action, id);
  }
}

function existingInboxCommand(
  client: MailClient,
  action: string | undefined,
  id: string | undefined,
) {
  switch (action) {
    case "get":
      return client.call("GET", path(id));
    case "enable":
    case "disable":
      return client.call("PATCH", path(id), { active: action === "enable" });
    case "rotate-token":
      return client.call("POST", `${path(id)}/token`);
    default:
      throw new Error("Unknown inbox command");
  }
}

async function download(client: MailClient, args: Arguments, messagePath: string) {
  const {
    values,
    positionals: [, action],
  } = args;
  const output = required(values.output, "--output");
  const url =
    action === "raw"
      ? `${messagePath}/raw`
      : `${messagePath}/attachments/${encoded(args.positionals[4], "INDEX")}`;
  const response = await client.response("GET", url);
  const content = response.body
    ? await readBounded(response.body, MAX_MAIL_BYTES)
    : new ArrayBuffer(0);
  const file = await open(output, "wx", 0o600);
  try {
    await file.writeFile(new Uint8Array(content));
  } finally {
    await file.close();
  }
  return { output };
}

async function messageCommand(client: MailClient, args: Arguments) {
  const {
    values,
    positionals: [, action, id, extra],
  } = args;
  if (action === "list") {
    return listMessages(client, values, id);
  }
  const messagePath = `${path(id)}/messages/${encoded(extra, "MESSAGE_ID")}`;
  switch (action) {
    case "get":
      return client.call("GET", messagePath);
    case "reprocess":
      return client.call("POST", `${messagePath}/reprocess`);
    case "raw":
    case "attachment":
      return download(client, args, messagePath);
    default:
      throw new Error("Unknown message command");
  }
}

function listMessages(client: MailClient, values: Values, id: string | undefined) {
  const query = new URLSearchParams({ limit: values.limit ?? "25" });
  if (values.cursor) query.set("cursor", values.cursor);
  return client.call("GET", `${path(id)}/messages?${query}`);
}

function outboxCommand(
  client: MailClient,
  { values, positionals: [, action, id, extra] }: Arguments,
) {
  switch (action) {
    case "list":
      return client.call("GET", `${path(id)}/outbox?${pagination(values)}`);
    case "get":
      return client.call("GET", `${path(id)}/outbox/${encoded(extra, "SEND_ID")}`);
    case "resolve":
      return client.call("POST", `${path(id)}/outbox/${encoded(extra, "SEND_ID")}/resolve`, {
        outcome: required(values.outcome, "--outcome"),
        note: required(values.note, "--note"),
      });
    default:
      throw new Error("Unknown outbox command");
  }
}

async function sendCommand(client: MailClient, { values, positionals: [, id] }: Arguments) {
  return client.call(
    "POST",
    `${path(id)}/send`,
    {
      to: values.to ?? [],
      subject: required(values.subject, "--subject"),
      ...(await mailBody(values)),
    },
    required(values["idempotency-key"], "--idempotency-key"),
  );
}
async function replyCommand(
  client: MailClient,
  { values, positionals: [, id, message] }: Arguments,
) {
  return client.call(
    "POST",
    `${path(id)}/messages/${encoded(message, "MESSAGE_ID")}/reply`,
    await mailBody(values),
    required(values["idempotency-key"], "--idempotency-key"),
  );
}

function eventQuery(values: Values) {
  return {
    name: values.name ?? "message.received",
    arguments: values.inbox ? { inbox_id: inboxId(values.inbox) } : {},
    cursor: values.cursor ?? null,
    ...(values["max-age-ms"] === undefined ? {} : { maxAgeMs: Number(values["max-age-ms"]) }),
    maxEvents: Number(values.limit ?? 25),
  };
}
async function eventsCommand(client: MailClient, { values, positionals: [, action] }: Arguments) {
  if (action === "list") return { result: await client.call("GET", "/v1/events") };
  if (action !== "poll" && action !== "watch") throw new Error("Unknown events command");
  const query = eventQuery(values);
  validateEventCursorOptions(values, action);
  if (action === "poll") return { result: await client.call("POST", "/v1/events/poll", query) };
  await watchEvents(client, query, values["cursor-file"]);
  return null;
}

function validateEventCursorOptions(values: Values, action: string): void {
  if (values.cursor && values["cursor-file"]) throw new Error("Choose --cursor or --cursor-file");
  if (action === "poll" && values["cursor-file"])
    throw new Error("--cursor-file is supported by events watch; use --cursor for a single poll");
}

async function domainCommand(client: MailClient, { values, positionals: [, action] }: Arguments) {
  if (action !== "check") throw new Error("Unknown command: domain");
  const result = await client.call("GET", "/v1/domain/check");
  const report = z.object({ status: z.enum(["pass", "warning", "fail", "unknown"]) }).parse(result);
  process.exitCode =
    report.status === "unknown"
      ? 2
      : report.status === "fail" || (values.strict && report.status === "warning")
        ? 1
        : 0;
  return result;
}

type CliOutput = { result: unknown } | null;
type CliCommand = (client: MailClient, args: Arguments) => Promise<CliOutput>;
function withOutput(
  command: (client: MailClient, args: Arguments) => Promise<unknown>,
): CliCommand {
  return async (client, args) => ({ result: await command(client, args) });
}
const commands = new Map<string, CliCommand>([
  ["health", async (client) => ({ result: await client.call("GET", "/v1/health") })],
  ["domain", withOutput(domainCommand)],
  ["inbox", withOutput(inboxCommand)],
  ["message", withOutput(messageCommand)],
  ["outbox", withOutput(outboxCommand)],
  ["send", withOutput(sendCommand)],
  ["reply", withOutput(replyCommand)],
  ["events", eventsCommand],
]);

export async function executeCli(client: MailClient, args: Arguments): Promise<CliOutput> {
  const [name] = args.positionals;
  const command = commands.get(name);
  if (!command) throw new Error(`Unknown command: ${name}`);
  return command(client, args);
}
