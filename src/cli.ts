#!/usr/bin/env bun
import { version } from "../package.json";
import { MailClient } from "./client";
import { executeCli, parseCliArgs, required } from "./cli-commands";

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

function showInfo(args: ReturnType<typeof parseCliArgs>): boolean {
  const { values, positionals } = args;
  if (values.version || positionals[0] === "version") {
    console.log(`agentpost ${version}`);
    return true;
  }
  if (values.help || positionals.length === 0) {
    console.log(help);
    return true;
  }
  return false;
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const { values, positionals } = args;
  if (showInfo(args)) return;
  if (positionals[0] === "mcp") {
    if (values.url) process.env.AGENTPOST_API_URL = values.url;
    await import("./mcp");
    return;
  }
  const client = new MailClient({
    url: values.url ?? required(process.env.AGENTPOST_API_URL, "AGENTPOST_API_URL"),
    token: required(process.env.AGENTPOST_API_TOKEN, "AGENTPOST_API_TOKEN"),
  });
  const output = await executeCli(client, args);
  if (output) console.log(JSON.stringify(output.result));
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "agentpost failed");
  process.exitCode = 1;
}
