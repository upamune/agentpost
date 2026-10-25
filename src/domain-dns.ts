import { z } from "zod";
import { readBounded } from "./common";

const answerSchema = z.object({
  name: z.string().max(254),
  type: z.number().int(),
  data: z.string().max(16_384),
});
const responseSchema = z.object({
  Status: z.number().int(),
  TC: z.boolean(),
  Question: z.array(z.object({ name: z.string(), type: z.number().int() })).length(1),
  Answer: z.array(answerSchema).max(128).optional(),
});

export function dnsName(value: string): string {
  const name = value.toLowerCase().replace(/\.$/, "");
  if (
    name.length > 253 ||
    !name.split(".").every((label) => /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/.test(label))
  )
    throw new Error("Invalid DNS name");
  return name;
}

/** Decode one TXT RR's quoted character-strings; do not merge separate RRs. */
export function dnsTxt(data: string): string {
  return new TxtReader(data).read();
}

class TxtReader {
  private offset = 0;
  constructor(private readonly data: string) {}

  private skipHorizontalSpace(): void {
    while (/[ \t]/.test(this.data[this.offset] ?? "") && this.offset < this.data.length)
      this.offset++;
  }

  private escape(): string {
    const decimal = this.data.slice(this.offset, this.offset + 3);
    if (/^\d{3}$/.test(decimal)) {
      const byte = Number(decimal);
      if (byte > 255) throw new Error("Invalid TXT escape");
      this.offset += 3;
      return String.fromCharCode(byte);
    }
    if (this.offset === this.data.length) throw new Error("Invalid TXT escape");
    return this.data[this.offset++]!;
  }

  private chunk(): string {
    if (this.data[this.offset++] !== '"') throw new Error("Invalid TXT encoding");
    let result = "";
    while (this.offset < this.data.length) {
      const char = this.data[this.offset++];
      if (char === '"') return result;
      result += char === "\\" ? this.escape() : char;
    }
    throw new Error("Unclosed TXT string");
  }

  read(): string {
    let result = "";
    let chunks = 0;
    while (this.offset < this.data.length) {
      this.skipHorizontalSpace();
      if (this.offset === this.data.length) break;
      result += this.chunk();
      chunks++;
      if (this.offset < this.data.length && !/[ \t]/.test(this.data[this.offset]!))
        throw new Error("Invalid TXT separator");
    }
    if (!chunks) throw new Error("Empty TXT encoding");
    return result;
  }
}

export async function diagnosticJson(url: URL, headers: HeadersInit, signal: AbortSignal) {
  const response = await fetch(url, {
    headers,
    // workerd supports manual/follow, but rejects the standard "error" mode.
    // Non-2xx responses below fail without following a Location header.
    redirect: "manual",
    signal: AbortSignal.any([signal, AbortSignal.timeout(3500)]),
  });
  if (!response.ok || !response.body) {
    void response.body?.cancel().catch(() => {});
    throw new Error("Diagnostic upstream unavailable");
  }
  return JSON.parse(new TextDecoder().decode(await readBounded(response.body, 256 * 1024)));
}

/** Fixed DoH origin, bounded work, and only records reachable from the question. */
export function publicDns(signal: AbortSignal) {
  const cache = new Map<string, Promise<string[]>>();
  return (name: string, type: "TXT" | "MX"): Promise<string[]> => {
    name = dnsName(name);
    const key = `${name}:${type}`;
    let result = cache.get(key);
    if (!result) {
      if (cache.size >= 24) throw new Error("DNS diagnostic query budget exhausted");
      result = queryDns(name, type, signal);
      cache.set(key, result);
    }
    return result;
  };
}

type DnsAnswer = z.output<typeof answerSchema>;
const recordCodes = { TXT: 16, MX: 15 };

async function queryDns(name: string, type: "TXT" | "MX", signal: AbortSignal) {
  const url = new URL("https://cloudflare-dns.com/dns-query");
  url.search = new URLSearchParams({ name, type }).toString();
  const response = responseSchema.parse(
    await diagnosticJson(url, { Accept: "application/dns-json" }, signal),
  );
  const question = response.Question[0]!;
  if (dnsName(question.name) !== name || question.type !== recordCodes[type] || response.TC)
    throw new Error("Incomplete or mismatched DNS response");
  if (response.Status === 3) return [];
  if (response.Status !== 0) throw new Error("DNS resolution failed");
  return resolveAnswers(response.Answer ?? [], name, type);
}

function answerNode(
  answers: DnsAnswer[],
  owner: string,
  code: number,
  hop: number,
): { alias: string } | { records: DnsAnswer[] } {
  const owned = answers.filter((answer) => dnsName(answer.name) === owner);
  const aliases = owned.filter((answer) => answer.type === 5);
  const records = owned.filter((answer) => answer.type === code);
  if (!aliases.length) return { records };
  if (aliases.length !== 1 || records.length || hop === 8) throw new Error("Ambiguous DNS alias");
  return { alias: dnsName(aliases[0]!.data) };
}

function resolveAnswers(answers: DnsAnswer[], name: string, type: "TXT" | "MX") {
  let owner = name;
  const visited = new Set<string>();
  for (let hop = 0; hop <= 8; hop++) {
    if (visited.has(owner)) throw new Error("DNS alias loop");
    visited.add(owner);
    const node = answerNode(answers, owner, recordCodes[type], hop);
    if ("alias" in node) {
      owner = node.alias;
      continue;
    }
    if (!node.records.length && owner !== name) throw new Error("Incomplete DNS alias answer");
    return [
      ...new Set(
        node.records.map((answer) => (type === "TXT" ? dnsTxt(answer.data) : answer.data)),
      ),
    ];
  }
  throw new Error("DNS alias limit");
}
