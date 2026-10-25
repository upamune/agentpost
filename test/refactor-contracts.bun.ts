import { expect, test } from "bun:test";
import fc from "fast-check";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";
import { executeCli, parseCliArgs } from "../src/cli-commands";
import { MailClient } from "../src/client";
import { createMailServer } from "../src/mcp-server";
import { dnsTxt } from "../src/domain-dns";

const inbox = "11111111-1111-4111-8111-111111111111";
const message = "a".repeat(64);
const base = `/v1/inboxes/${inbox}`;
type CommandCase = {
  name: string;
  args: string[];
  method: string;
  path: string;
  body?: unknown;
  key?: string;
};
const commands: CommandCase[] = [
  { name: "health", args: ["health"], method: "GET", path: "/v1/health" },
  {
    name: "random inbox",
    args: ["inbox", "create"],
    method: "POST",
    path: "/v1/inboxes",
    body: { label: "" },
  },
  {
    name: "named inbox",
    args: ["inbox", "create", "--local-part", "Research.Team+1", "--label", "lab"],
    method: "POST",
    path: "/v1/inboxes",
    body: { label: "lab", local_part: "Research.Team+1" },
  },
  {
    name: "inbox pagination",
    args: ["inbox", "list", "--limit", "2", "--offset", "3"],
    method: "GET",
    path: "/v1/inboxes?limit=2&offset=3",
  },
  { name: "inbox get", args: ["inbox", "get", inbox], method: "GET", path: base },
  {
    name: "inbox enable",
    args: ["inbox", "enable", inbox],
    method: "PATCH",
    path: base,
    body: { active: true },
  },
  {
    name: "inbox disable",
    args: ["inbox", "disable", inbox],
    method: "PATCH",
    path: base,
    body: { active: false },
  },
  {
    name: "token rotation",
    args: ["inbox", "rotate-token", inbox],
    method: "POST",
    path: `${base}/token`,
  },
  {
    name: "message pagination",
    args: ["message", "list", inbox, "--cursor", "opaque:cursor"],
    method: "GET",
    path: `${base}/messages?limit=25&cursor=opaque%3Acursor`,
  },
  {
    name: "message get",
    args: ["message", "get", inbox, message],
    method: "GET",
    path: `${base}/messages/${message}`,
  },
  {
    name: "message reprocess",
    args: ["message", "reprocess", inbox, message],
    method: "POST",
    path: `${base}/messages/${message}/reprocess`,
  },
  {
    name: "outbox pagination",
    args: ["outbox", "list", inbox],
    method: "GET",
    path: `${base}/outbox?limit=25&offset=0`,
  },
  {
    name: "outbox get",
    args: ["outbox", "get", inbox, "send-1"],
    method: "GET",
    path: `${base}/outbox/send-1`,
  },
  {
    name: "outbox resolution",
    args: [
      "outbox",
      "resolve",
      inbox,
      "send-1",
      "--outcome",
      "failed",
      "--note",
      "Provider confirmed no send",
    ],
    method: "POST",
    path: `${base}/outbox/send-1/resolve`,
    body: { outcome: "failed", note: "Provider confirmed no send" },
  },
  {
    name: "send",
    args: [
      "send",
      inbox,
      "--to",
      "one@example.net",
      "--to",
      "two@example.net",
      "--subject",
      "Subject",
      "--text",
      "本文",
      "--idempotency-key",
      "same-key",
    ],
    method: "POST",
    path: `${base}/send`,
    body: { to: ["one@example.net", "two@example.net"], subject: "Subject", text: "本文" },
    key: "same-key",
  },
  {
    name: "reply",
    args: ["reply", inbox, message, "--text", "Reply", "--idempotency-key", "reply-key"],
    method: "POST",
    path: `${base}/messages/${message}/reply`,
    body: { text: "Reply" },
    key: "reply-key",
  },
  { name: "event catalog", args: ["events", "list"], method: "GET", path: "/v1/events" },
  {
    name: "event query",
    args: [
      "events",
      "poll",
      "--inbox",
      inbox,
      "--cursor",
      "checkpoint",
      "--limit",
      "5",
      "--max-age-ms",
      "0",
    ],
    method: "POST",
    path: "/v1/events/poll",
    body: {
      name: "message.received",
      arguments: { inbox_id: inbox },
      cursor: "checkpoint",
      maxAgeMs: 0,
      maxEvents: 5,
    },
  },
];

for (const scenario of commands) {
  test(`CLI ${scenario.name} preserves its HTTP contract`, async () => {
    const requests: unknown[] = [];
    const client = new MailClient({
      url: "https://mail.example.com",
      token: "c".repeat(64),
      fetch: async (url, init) => {
        const headers = new Headers(init.headers);
        requests.push({
          method: init.method,
          path: url.pathname + url.search,
          body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
          key: headers.get("Idempotency-Key"),
          token: headers.get("Authorization"),
          redirect: init.redirect,
        });
        return Response.json({ ok: true });
      },
    });
    expect(await executeCli(client, parseCliArgs(scenario.args))).toEqual({ result: { ok: true } });
    expect(requests).toEqual([
      {
        method: scenario.method,
        path: scenario.path,
        body: scenario.body,
        key: scenario.key ?? null,
        token: `Bearer ${"c".repeat(64)}`,
        redirect: "manual",
      },
    ]);
  });
}

test("unknown and prototype-named commands never dispatch requests", async () => {
  let requests = 0;
  const client = new MailClient({
    url: "https://mail.example.com",
    token: "fixture",
    fetch: async () => {
      requests++;
      return Response.json({});
    },
  });
  for (const command of ["unknown", "constructor", "toString", "__proto__"])
    await expect(executeCli(client, parseCliArgs([command]))).rejects.toThrow(
      `Unknown command: ${command}`,
    );
  expect(requests).toBe(0);
});

function quoteTxt(value: string): string {
  const encoded = Array.from(value, (char) => {
    if (char === '"' || char === "\\") return `\\${char}`;
    const code = char.charCodeAt(0);
    return code < 32 || (code >= 127 && code <= 255)
      ? `\\${code.toString().padStart(3, "0")}`
      : char;
  }).join("");
  return `"${encoded}"`;
}

test("DNS TXT decoding preserves adjacent strings, decimal octets, and UTF-16 units", () => {
  const text = fc
    .array(fc.integer({ min: 0, max: 0xffff }), { maxLength: 40 })
    .map((codes) => String.fromCharCode(...codes));
  fc.assert(
    fc.property(text, text, (first, second) => {
      expect(dnsTxt(` \t${quoteTxt(first)} \t ${quoteTxt(second)} `)).toBe(first + second);
    }),
    { numRuns: 2000, seed: 20261026 },
  );
});

for (const malformed of ["", " \t ", '"unclosed', '"a""b"', '"a"x', '"\\999"', '"a\\']) {
  test(`DNS TXT rejects malformed presentation ${JSON.stringify(malformed)}`, () => {
    expect(() => dnsTxt(malformed)).toThrow();
  });
}

for (const [status, code, data] of [
  [400, -32602, undefined],
  [401, -32024, undefined],
  [403, -32024, undefined],
  [404, -32023, { kind: "event" }],
  [429, -32603, { retryAfterMs: 1000 }],
  [500, -32603, undefined],
] as const) {
  test(`MCP event polling preserves API error ${status}`, async () => {
    const server = createMcpHandler(() =>
      createMailServer(
        new MailClient({
          url: "https://mail.example.com",
          token: "fixture",
          fetch: async () =>
            new Response("private upstream text", { status, headers: { "Retry-After": "1" } }),
        }),
      ),
    );
    const client = new Client(
      { name: "event-error-contract", version: "1" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
        fetch: (url, init) => server.fetch(new Request(url, init)),
      }),
    );
    try {
      await expect(
        client.request(
          {
            method: "events/poll",
            params: { name: "message.received", arguments: {}, cursor: "checkpoint" },
          },
          z.unknown(),
        ),
      ).rejects.toMatchObject({ code, ...(data ? { data } : {}) });
    } finally {
      await client.close();
      await server.close();
    }
  });
}
