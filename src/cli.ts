#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { open } from "node:fs/promises";
import { MAX_MAIL_BYTES, readBounded } from "./common";
import { version } from "../package.json";
import { MailClient } from "./client";
import { inboxInputSchema } from "./inbox-schema";
import { watchEvents } from "./watch";
import { z } from "zod";

const help = `agentpost — email for AI agents

Configuration: AGENTPOST_API_URL and AGENTPOST_API_TOKEN (admin or inbox token).
Use --url to override the URL. Credentials are read from the environment.

  inbox create [--local-part NAME] [--label LABEL]
  inbox list [--limit N] [--offset N]
  inbox get|enable|disable|rotate-token INBOX_ID
  message list INBOX_ID [--limit N] [--cursor CURSOR]
  message get|reprocess INBOX_ID MESSAGE_ID
  message raw INBOX_ID MESSAGE_ID --output FILE
  message attachment INBOX_ID MESSAGE_ID INDEX --output FILE
  send INBOX_ID --to ADDRESS [--to ADDRESS] --subject SUBJECT
       (--text TEXT | --text-file FILE) [--html-file FILE] --idempotency-key KEY
  reply INBOX_ID MESSAGE_ID (--text TEXT | --text-file FILE) --idempotency-key KEY
  outbox list INBOX_ID [--limit N] [--offset N]
  outbox get INBOX_ID SEND_ID
  outbox resolve INBOX_ID SEND_ID --outcome accepted|failed --note EVIDENCE
  events list
  events poll|watch [--name message.received] [--inbox INBOX_ID]
       [--cursor CURSOR] [--max-age-ms N] [--limit N]
       watch also accepts --cursor-file FILE for persistent checkpoints
  domain check [--strict]
  health
  mcp

JSON to stdout; watch emits NDJSON. A send returns its durable outbox state,
not proof of delivery. Reuse the same key when retrying the same send.
Events watch starts from now unless a cursor is supplied. --cursor-file
checkpoints after output is flushed. Replay is at-least-once; dedupe by eventId.
`;

function required(value: string | undefined, label: string): string {
  if (!value) throw new Error(`${label} is required. Use --help for usage.`);
  return value;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
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
  if (values.version || positionals[0] === "version") {
    console.log(`agentpost ${version}`);
    return;
  }
  if (values.help || positionals.length === 0) {
    console.log(help);
    return;
  }
  if (positionals[0] === "mcp") {
    if (values.url) process.env.AGENTPOST_API_URL = values.url;
    await import("./mcp");
    return;
  }
  const client = new MailClient({
    url: values.url ?? required(process.env.AGENTPOST_API_URL, "AGENTPOST_API_URL"),
    token: required(process.env.AGENTPOST_API_TOKEN, "AGENTPOST_API_TOKEN"),
  });
  const [command, action, id, extra] = positionals;
  const inboxId = (value: string | undefined) => z.uuid().parse(required(value, "INBOX_ID"));
  const path = (value: string | undefined) => `/v1/inboxes/${inboxId(value)}`;
  const encoded = (value: string | undefined, label: string) =>
    encodeURIComponent(required(value, label));
  const page = new URLSearchParams({ limit: values.limit ?? "25", offset: values.offset ?? "0" });
  const body = async () => {
    if (values.text !== undefined && values["text-file"] !== undefined)
      throw new Error("Choose --text or --text-file");
    return {
      text: values["text-file"]
        ? await Bun.file(values["text-file"]).text()
        : required(values.text, "--text or --text-file"),
      ...(values["html-file"] ? { html: await Bun.file(values["html-file"]).text() } : {}),
    };
  };
  let result: unknown;
  if (command === "health") result = await client.call("GET", "/v1/health");
  else if (command === "domain" && action === "check") {
    result = await client.call("GET", "/v1/domain/check");
    const report = z
      .object({ status: z.enum(["pass", "warning", "fail", "unknown"]) })
      .parse(result);
    process.exitCode =
      report.status === "unknown"
        ? 2
        : report.status === "fail" || (values.strict && report.status === "warning")
          ? 1
          : 0;
  } else if (command === "inbox") {
    if (action === "create")
      result = await client.call(
        "POST",
        "/v1/inboxes",
        inboxInputSchema.parse({
          label: values.label ?? "",
          local_part: values["local-part"],
        }),
      );
    else if (action === "list") result = await client.call("GET", `/v1/inboxes?${page}`);
    else if (action === "get") result = await client.call("GET", path(id));
    else if (action === "enable" || action === "disable")
      result = await client.call("PATCH", path(id), { active: action === "enable" });
    else if (action === "rotate-token") result = await client.call("POST", `${path(id)}/token`);
    else throw new Error("Unknown inbox command");
  } else if (command === "message") {
    if (action === "list") {
      const query = new URLSearchParams({ limit: values.limit ?? "25" });
      if (values.cursor) query.set("cursor", values.cursor);
      result = await client.call("GET", `${path(id)}/messages?${query}`);
    } else {
      const messagePath = `${path(id)}/messages/${encoded(extra, "MESSAGE_ID")}`;
      if (action === "get") result = await client.call("GET", messagePath);
      else if (action === "reprocess")
        result = await client.call("POST", `${messagePath}/reprocess`);
      else if (action === "raw" || action === "attachment") {
        const output = required(values.output, "--output");
        const url =
          action === "raw"
            ? `${messagePath}/raw`
            : `${messagePath}/attachments/${encoded(positionals[4], "INDEX")}`;
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
        result = { output };
      } else throw new Error("Unknown message command");
    }
  } else if (command === "send") {
    result = await client.call(
      "POST",
      `${path(action)}/send`,
      {
        to: values.to ?? [],
        subject: required(values.subject, "--subject"),
        ...(await body()),
      },
      required(values["idempotency-key"], "--idempotency-key"),
    );
  } else if (command === "reply") {
    result = await client.call(
      "POST",
      `${path(action)}/messages/${encoded(id, "MESSAGE_ID")}/reply`,
      await body(),
      required(values["idempotency-key"], "--idempotency-key"),
    );
  } else if (command === "outbox") {
    if (action === "list") result = await client.call("GET", `${path(id)}/outbox?${page}`);
    else if (action === "get")
      result = await client.call("GET", `${path(id)}/outbox/${encoded(extra, "SEND_ID")}`);
    else if (action === "resolve")
      result = await client.call(
        "POST",
        `${path(id)}/outbox/${encoded(extra, "SEND_ID")}/resolve`,
        {
          outcome: required(values.outcome, "--outcome"),
          note: required(values.note, "--note"),
        },
      );
    else throw new Error("Unknown outbox command");
  } else if (command === "events") {
    if (action === "list") result = await client.call("GET", "/v1/events");
    else if (action === "poll" || action === "watch") {
      const query = {
        name: values.name ?? "message.received",
        arguments: values.inbox ? { inbox_id: inboxId(values.inbox) } : {},
        cursor: values.cursor ?? null,
        ...(values["max-age-ms"] === undefined ? {} : { maxAgeMs: Number(values["max-age-ms"]) }),
        maxEvents: Number(values.limit ?? 25),
      };
      if (values.cursor && values["cursor-file"])
        throw new Error("Choose --cursor or --cursor-file");
      if (action === "poll" && values["cursor-file"])
        throw new Error(
          "--cursor-file is supported by events watch; use --cursor for a single poll",
        );
      if (action === "poll") result = await client.call("POST", "/v1/events/poll", query);
      else {
        await watchEvents(client, query, values["cursor-file"]);
        return;
      }
    } else throw new Error("Unknown events command");
  } else throw new Error(`Unknown command: ${command}`);
  console.log(JSON.stringify(result));
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "agentpost failed");
  process.exitCode = 1;
}
