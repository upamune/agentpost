import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { stringifyBoundedJson } from "../src/bounded-json";
import { MailClient } from "../src/client";
import { readBounded } from "../src/common";
import { inboxInputSchema } from "../src/inbox-schema";

function integerSetting(name: string, fallback: number | undefined, min: number, max: number) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  const parsed = Number(value);
  if (parsed < min || parsed > max)
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return parsed;
}
const numRuns = integerSetting("AGENTPOST_FUZZ_RUNS", 1000, 1, 100_000)!;
const seed = integerSetting("AGENTPOST_FUZZ_SEED", undefined, -2_147_483_648, 2_147_483_647);
const path = process.env.AGENTPOST_FUZZ_PATH;
if (path !== undefined && !/^\d+(?::\d+)*$/.test(path))
  throw new Error("AGENTPOST_FUZZ_PATH must be a fast-check replay path such as 0:1:2");
const parameters = { numRuns, ...(seed === undefined ? {} : { seed }), ...(path ? { path } : {}) };
const timeout = 60_000;
const utf16Unit = fc.integer({ min: 0, max: 0xffff }).map((unit) => String.fromCharCode(unit));
const utf16 = fc.string({ unit: utf16Unit, maxLength: 64 });
const hostile = fc.constantFrom(
  "\u0000\u0001\u001f\b\t\n\f\r",
  "\ud800",
  "\udfff",
  "\ud800\ud800\udfff",
  '"\\',
  "é日😀",
  "\u001b]52;c;c2VjcmV0\u0007",
);

describe("generative security boundary checks", () => {
  test(
    "JSON preflight agrees with actual serialized UTF-8 at and below the exact budget",
    () => {
      const value = fc.anything({
        maxDepth: 3,
        maxKeys: 6,
        key: fc.oneof(utf16, hostile),
        values: [
          fc.oneof(utf16, hostile),
          fc.double(),
          fc.boolean(),
          fc.constant(null),
          fc.constant(undefined),
        ],
        withNullPrototype: true,
      });
      fc.assert(
        fc.property(value, fc.integer({ min: 0, max: 64 }), (payload, extra) => {
          const document = { payload };
          const reference = JSON.stringify(document);
          const bytes = new TextEncoder().encode(reference).byteLength;
          expect(stringifyBoundedJson(document, bytes)).toBe(reference);
          expect(stringifyBoundedJson(document, bytes + extra)).toBe(reference);
          expect(() => stringifyBoundedJson(document, bytes - 1)).toThrow("JSON size limit");
        }),
        parameters,
      );
    },
    timeout,
  );

  test(
    "stream byte budgets preserve exact content or cancel on overflow for arbitrary chunking",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.uint8Array({ maxLength: 64 }), { maxLength: 12 }),
          fc.integer({ min: 0, max: 768 }),
          async (chunks, budget) => {
            const reference = Buffer.concat(chunks);
            let next = 0;
            let cancelled = false;
            const stream = new ReadableStream<Uint8Array>(
              {
                pull(controller) {
                  if (next === chunks.length) controller.close();
                  else controller.enqueue(chunks[next++]);
                },
                cancel() {
                  cancelled = true;
                },
              },
              { highWaterMark: 0 },
            );
            if (reference.byteLength <= budget) {
              expect(Buffer.from(await readBounded(stream, budget)).equals(reference)).toBe(true);
              expect(cancelled).toBe(false);
            } else {
              await expect(readBounded(stream, budget)).rejects.toThrow(
                "Message exceeds size limit",
              );
              expect(cancelled).toBe(true);
            }
            expect(stream.locked).toBe(false);
          },
        ),
        parameters,
      );
    },
    timeout,
  );

  test(
    "arbitrary request paths never send bearer credentials outside the configured HTTPS API",
    async () => {
      const origin = "https://mail.example.com";
      const attack = fc.oneof(
        utf16,
        fc.webUrl(),
        fc.constantFrom(
          "//attacker.invalid/v1/inboxes",
          "/\\attacker.invalid/v1/inboxes",
          "/v1/%2e%2e/steal",
          "/v1/.%2e/.%2e/steal",
          "/v1/inboxes#fragment",
          "\nhttps://attacker.invalid/v1/inboxes",
          "../steal",
          "/v1/inboxes",
        ),
        utf16.map((suffix) => `/v1/${suffix}`),
      );
      await fc.assert(
        fc.asyncProperty(attack, async (candidate) => {
          let parses = true;
          try {
            new URL(candidate, origin);
          } catch (error) {
            if (!(error instanceof TypeError)) throw error;
            parses = false;
          }
          const client = new MailClient({
            url: origin,
            token: "synthetic-fuzz-token",
            fetch: async (target, init) => {
              expect(target.origin).toBe(origin);
              expect(target.protocol).toBe("https:");
              expect(target.pathname.startsWith("/v1/")).toBe(true);
              expect(target.username).toBe("");
              expect(target.password).toBe("");
              expect(target.hash).toBe("");
              expect(init.redirect).toBe("manual");
              expect(new Headers(init.headers).get("Authorization")).toBe(
                "Bearer synthetic-fuzz-token",
              );
              return Response.json({ ok: true });
            },
          });
          try {
            await client.call("GET", candidate);
          } catch (error) {
            if (
              error instanceof Error &&
              error.message === "Mail API path must stay within the configured origin and /v1/"
            )
              return;
            if (error instanceof TypeError && !parses) return;
            throw error;
          }
        }),
        parameters,
      );
    },
    timeout,
  );

  test(
    "HTTP redirect responses never trigger a second credential-bearing request",
    async () => {
      let followed = 0;
      let requests = 0;
      let status = 302;
      const destination = Bun.serve({
        port: 0,
        fetch: () => {
          followed++;
          return Response.json({});
        },
      });
      let location = destination.url.href;
      const source = Bun.serve({
        port: 0,
        fetch: () => {
          requests++;
          return new Response(null, { status, headers: { Location: location } });
        },
      });
      const client = new MailClient({ url: source.url.href, token: "synthetic-fuzz-token" });
      try {
        await fc.assert(
          fc.asyncProperty(
            fc.constantFrom(301, 302, 303, 307, 308),
            fc.boolean(),
            async (code, relative) => {
              status = code;
              location = relative ? "/v1/redirect-target" : destination.url.href;
              const before = requests;
              await expect(client.call("GET", "/v1/inboxes")).rejects.toThrow(
                `Mail API HTTP ${code}`,
              );
              expect(requests - before).toBe(1);
              expect(followed).toBe(0);
            },
          ),
          parameters,
        );
      } finally {
        await source.stop(true);
        await destination.stop(true);
      }
    },
    timeout,
  );

  test(
    "mailbox names reject control characters and address/header/path injection",
    () => {
      const plain = fc.string({
        unit: fc.constantFrom(
          ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_+-",
        ),
        minLength: 1,
        maxLength: 20,
      });
      const injection = fc.oneof(
        fc.integer({ min: 0, max: 31 }).map((code) => String.fromCharCode(code)),
        fc.constantFrom(
          "\u007f",
          "\r\nBcc: victim@example.net",
          "@attacker.invalid",
          "/../",
          "\\",
          "<",
          ">",
          " ",
          "..",
          "é",
          "\ud800",
        ),
      );
      fc.assert(
        fc.property(plain, injection, plain, (prefix, attack, suffix) => {
          expect(
            inboxInputSchema.safeParse({ local_part: `${prefix}${attack}${suffix}` }).success,
          ).toBe(false);
          const legitimate = `${prefix}.${suffix}`;
          expect(inboxInputSchema.parse({ local_part: legitimate }).local_part).toBe(legitimate);
        }),
        parameters,
      );
    },
    timeout,
  );
});
