import { z } from "zod";
import { diagnosticJson, dnsName, dnsTxt } from "./domain-dns";
import { tags } from "./domain-context";
import type { DomainDiagnostics, ProviderRecord } from "./domain-context";
const id = z.string().regex(/^[a-f0-9]{32}$/);
const subdomain = z.object({
  success: z.literal(true),
  result: z.object({
    enabled: z.boolean(),
    name: z.string().max(254),
    tag: id,
    dkim_selector: z.string().max(253).optional(),
    return_path_domain: z.string().max(253).optional(),
  }),
});

async function sendingDetails(settings: (string | undefined)[], signal: AbortSignal) {
  const zone = id.parse(settings[0]);
  const row = id.parse(settings[1]);
  const token = z
    .string()
    .min(1)
    .max(256)
    .regex(/^[a-zA-Z0-9_-]+$/)
    .parse(settings[2]);
  const base = new URL(
    `https://api.cloudflare.com/client/v4/zones/${zone}/email/sending/subdomains/${row}`,
  );
  const headers = { Authorization: `Bearer ${token}` };
  const [details, expected] = await Promise.all([
    diagnosticJson(base, headers, signal).then((value) => subdomain.parse(value).result),
    diagnosticJson(new URL(`${base.href}/dns`), headers, signal).then(
      (value) => expectedDns.parse(value).result,
    ),
  ]);
  return { row, details, expected };
}

function coveredDomain(details: z.output<typeof subdomain>["result"], domain: string, row: string) {
  const wildcard = details.name.startsWith("*.");
  const baseDomain = dnsName(wildcard ? details.name.slice(2) : details.name);
  if (
    details.tag !== row ||
    (wildcard ? !domain.endsWith(`.${baseDomain}`) : baseDomain !== domain)
  )
    return null;
  return baseDomain;
}
const expectedDns = z.object({
  success: z.literal(true),
  result: z
    .array(
      z.object({
        type: z.string().max(10),
        name: z.string().max(254),
        content: z.string().max(16_384),
        priority: z.number().int().min(0).max(65535).optional(),
      }),
    )
    .min(1)
    .max(20),
});

export async function checkSending(ctx: DomainDiagnostics) {
  const { env, domain, signal, add, run } = ctx;
  const settings = [
    env.AGENTPOST_CF_ZONE_ID,
    env.AGENTPOST_CF_SENDING_SUBDOMAIN_ID,
    env.AGENTPOST_CF_DIAGNOSTICS_API_TOKEN,
  ];
  if (settings.every((value) => !value)) {
    add(
      "cloudflare_sending",
      "unknown",
      "Cloudflare sending-domain state was not queried.",
      "Optionally configure the dedicated diagnostics credential and sending-domain IDs; DNS checks use Cloudflare's default sending names.",
    );
  } else {
    await run("cloudflare_sending", domain, async () => {
      const { row, details, expected } = await sendingDetails(settings, signal);
      const baseDomain = coveredDomain(details, domain, row);
      if (!baseDomain) {
        add(
          "cloudflare_sending",
          "fail",
          "The configured sending-domain row does not cover this mail domain.",
          "Use the sending subdomain ID for AGENTPOST_EMAIL_DOMAIN.",
        );
        return;
      }
      const nextSelector = dnsName(details.dkim_selector ?? "cf-bounce");
      const nextReturnPath = dnsName(details.return_path_domain ?? `cf-bounce.${baseDomain}`);
      if (!nextReturnPath.endsWith(`.${baseDomain}`)) throw new Error("Unexpected return path");
      ctx.signingDomain = baseDomain;
      ctx.selector = nextSelector;
      ctx.returnPath = nextReturnPath;
      ctx.providerRecords = expected;
      add(
        "cloudflare_sending",
        details.enabled ? "pass" : "fail",
        details.enabled
          ? "Cloudflare reports Email Sending enabled for the matching domain."
          : "Cloudflare reports Email Sending disabled.",
        details.enabled ? undefined : "Enable this domain in Cloudflare Email Sending.",
      );
    });
  }
}
export async function checkProviderDns(ctx: DomainDiagnostics) {
  const { domain, signingDomain, add, run } = ctx;
  const dkimName = `${ctx.selector}._domainkey.${signingDomain}`;
  await run("cloudflare_dns", domain, async () => {
    const { mismatch, custom } = await compareExpectedDns(ctx, dkimName);
    add(
      "cloudflare_dns",
      mismatch ? "fail" : custom ? "warning" : "pass",
      mismatch
        ? "Public sending keys or required records differ from Cloudflare's expected records."
        : custom
          ? "Sending keys match, but custom SPF or MX priorities differ from the provider profile."
          : "Public sending records match Cloudflare's expected records.",
      mismatch || custom
        ? "Compare the sending-domain DNS records in Cloudflare; check the active DKIM key, SPF, bounce MX, and propagation before changing records."
        : undefined,
    );
  });
}

async function compareExpectedDns(ctx: DomainDiagnostics, dkimName: string) {
  const expected = expectedRecords(ctx, dkimName);
  let mismatch = false;
  let custom = false;
  for (const record of expected) {
    const name = dnsName(record.name);
    if (!name.endsWith(`.${ctx.signingDomain}`) && name !== ctx.signingDomain)
      throw new Error("Unexpected expected DNS name");
    const values = await ctx.resolve(name, record.type === "TXT" ? "TXT" : "MX");
    const comparison = compareRecord(record, values, name === dkimName);
    mismatch ||= comparison.mismatch;
    custom ||= comparison.custom;
  }
  return { mismatch, custom };
}

function expectedRecords(ctx: DomainDiagnostics, dkimName: string) {
  const expected = ctx
    .providerRecords!.filter(
      (record) =>
        ["MX", "TXT"].includes(record.type) && !record.name.toLowerCase().startsWith("_dmarc."),
    )
    .map((record) => ({
      ...record,
      content:
        record.type === "TXT" && record.content.trimStart().startsWith('"')
          ? dnsTxt(record.content)
          : record.content,
    }));
  if (
    ![ctx.returnPath, dkimName].every((name) =>
      expected.some((record) => dnsName(record.name) === name && record.type === "TXT"),
    ) ||
    !expected.some((record) => dnsName(record.name) === ctx.returnPath && record.type === "MX")
  )
    throw new Error("Incomplete expected sending DNS");
  return expected;
}

function publishedDkimKey(value: string) {
  try {
    return tags(value).p?.replace(/[ \t]/g, "");
  } catch {
    return undefined;
  }
}
function compareDkim(content: string, values: string[]) {
  const wanted = tags(content).p?.replace(/[ \t]/g, "");
  if (!wanted) throw new Error("Missing expected DKIM key");
  return { mismatch: !values.some((value) => publishedDkimKey(value) === wanted), custom: false };
}
function compareSpf(content: string, values: string[]) {
  const normalize = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();
  return {
    mismatch: !values.some((value) => /^v=spf1(?:\s|$)/i.test(value)),
    custom: !values.some((value) => normalize(value) === normalize(content)),
  };
}
function compareMx(record: ProviderRecord, values: string[]) {
  if (record.priority === undefined) throw new Error("Missing MX priority");
  const host = record.content.toLowerCase().replace(/\.$/, "");
  const wanted = `${record.priority} ${host}`;
  return {
    mismatch: !values.some(
      (value) => value.toLowerCase().replace(/\.$/, "").split(/\s+/)[1] === host,
    ),
    custom: !values.some((value) => value.toLowerCase().replace(/\.$/, "") === wanted),
  };
}
function compareRecord(record: ProviderRecord, values: string[], dkim: boolean) {
  if (record.type === "TXT" && dkim) return compareDkim(record.content, values);
  if (record.type === "TXT" && /^v=spf1(?:\s|$)/i.test(record.content))
    return compareSpf(record.content, values);
  if (record.type === "MX") return compareMx(record, values);
  return { mismatch: !values.includes(record.content), custom: false };
}
