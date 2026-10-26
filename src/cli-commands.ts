import { basename } from "node:path";
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, attachmentIdsSchema } from "./attachment-policy";
import { parseArgs } from "node:util";
import { open } from "node:fs/promises";
import { z } from "zod";
import { MAX_MAIL_BYTES, MAX_REQUEST_BYTES, readBounded } from "./common";
import { MailClient } from "./client";
import { inboxInputSchema, inboxMetadataSchema, MAX_INBOX_NOTES_BYTES } from "./inbox-schema";
import { watchEvents } from "./watch";
import { readLocalBytes, readLocalText } from "./local-file";
import { resolveIdempotencyKey, withIdempotencyKey } from "./idempotency";
import { forwardingCommand } from "./cli-forwarding";
import { webhookCommand } from "./cli-webhooks";

export function parseCliArgs(args: string[]) {
  return parseArgs({
    args,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean" },
      url: { type: "string" },
      label: { type: "string" },
      notes: { type: "string" },
      "notes-file": { type: "string" },
      "site-url": { type: "string", multiple: true },
      "clear-urls": { type: "boolean" },
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
      attach: { type: "string", multiple: true },
      "attachment-id": { type: "string", multiple: true },
      text: { type: "string" },
      "text-file": { type: "string" },
      "html-file": { type: "string" },
      "idempotency-key": { type: "string" },
      "webhook-url": { type: "string" },
      output: { type: "string" },
      outcome: { type: "string" },
      note: { type: "string" },
      destination: { type: "string" },
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
      ? await readLocalText(values["text-file"], MAX_REQUEST_BYTES)
      : required(values.text, "--text or --text-file"),
    ...(values["html-file"]
      ? { html: await readLocalText(values["html-file"], MAX_REQUEST_BYTES) }
      : {}),
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
        inboxInputSchema.parse({
          ...(await inboxMetadata(values)),
          local_part: values["local-part"],
        }),
      );
    case "edit":
      if (values["local-part"] !== undefined)
        throw new Error("An existing inbox address cannot be renamed");
      return client.call(
        "PATCH",
        `${path(id)}/metadata`,
        inboxMetadataSchema.parse(await inboxMetadata(values)),
      );
    case "list":
      return client.call("GET", `/v1/inboxes?${pagination(values)}`);
    default:
      return existingInboxCommand(client, action, id);
  }
}

async function inboxNotes(values: Values) {
  if (values.notes !== undefined && values["notes-file"] !== undefined)
    throw new Error("Choose --notes or --notes-file");
  if (values["notes-file"] !== undefined)
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      await readLocalBytes(values["notes-file"], MAX_INBOX_NOTES_BYTES),
    );
  return values.notes;
}

function inboxSiteUrls(values: Values) {
  if (values["clear-urls"] && values["site-url"] !== undefined)
    throw new Error("Choose --site-url or --clear-urls");
  return values["clear-urls"] ? [] : values["site-url"];
}

async function inboxMetadata(values: Values) {
  return { label: values.label, notes: await inboxNotes(values), urls: inboxSiteUrls(values) };
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

async function uploadFile(client: MailClient, id: string, file: string) {
  return client.uploadAttachment(
    id,
    basename(file),
    await readLocalBytes(file, MAX_ATTACHMENT_BYTES),
  );
}

async function attachmentBody(client: MailClient, id: string, values: Values) {
  const files = values.attach ?? [];
  const ids = [...(values["attachment-id"] ?? [])];
  if (files.length + ids.length > MAX_ATTACHMENTS)
    throw new Error("At most 10 attachments are allowed");
  for (const file of files) {
    const result = z.object({ id: z.string() }).parse(await uploadFile(client, id, file));
    ids.push(result.id);
  }
  const attachments = attachmentIdsSchema.parse(ids);
  return attachments ? { attachments } : {};
}

async function attachmentCommand(client: MailClient, args: Arguments) {
  const [, action, id, file] = args.positionals;
  if (action !== "upload") throw new Error("Unknown attachment command");
  return uploadFile(client, inboxId(id), required(file, "FILE"));
}

async function sendCommand(client: MailClient, { values, positionals: [, id] }: Arguments) {
  const key = resolveIdempotencyKey(values["idempotency-key"]);
  return withIdempotencyKey(key, () => prepareSend(client, values, id, key));
}

async function prepareSend(
  client: MailClient,
  values: Values,
  id: string | undefined,
  key: string,
) {
  const inbox = inboxId(id);
  const subject = required(values.subject, "--subject");
  const to = z
    .array(z.email())
    .min(1)
    .max(50)
    .parse(values.to ?? []);
  const body = await mailBody(values);
  return client.callSend(
    `${path(inbox)}/send`,
    {
      to,
      subject,
      ...body,
      ...(await attachmentBody(client, inbox, values)),
    },
    key,
  );
}
async function replyCommand(
  client: MailClient,
  { values, positionals: [, id, message] }: Arguments,
) {
  const key = resolveIdempotencyKey(values["idempotency-key"]);
  return withIdempotencyKey(key, () => prepareReply(client, values, id, message, key));
}

async function prepareReply(
  client: MailClient,
  values: Values,
  id: string | undefined,
  message: string | undefined,
  key: string,
) {
  const inbox = inboxId(id);
  const messageId = encoded(message, "MESSAGE_ID");
  const body = await mailBody(values);
  return client.callSend(
    `${path(inbox)}/messages/${messageId}/reply`,
    {
      ...body,
      ...(await attachmentBody(client, inbox, values)),
    },
    key,
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
  ["attachment", withOutput(attachmentCommand)],
  ["outbox", withOutput(outboxCommand)],
  ["webhook", withOutput(webhookCommand)],
  ["forwarding", withOutput(forwardingCommand)],
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
