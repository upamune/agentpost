import { z } from "zod";
import { DomainDiagnostics } from "./domain-context";
import type { Check, Status } from "./domain-context";
import { checkDkim, checkDmarc } from "./domain-auth-records";
import { checkSending, checkProviderDns } from "./domain-provider";
import type { Env } from "./types";

async function checkMx(ctx: DomainDiagnostics, name: string, check: string) {
  const { run, resolve, add } = ctx;
  await run(check, name, async () => {
    const records = await resolve(name, "MX");
    const hosts = records.map((record) => {
      const match = record.match(/^\d{1,5}\s+(\S+)$/);
      if (!match) throw new Error("Invalid MX data");
      return match[1]!.toLowerCase().replace(/\.$/, "");
    });
    const status = mxStatus(hosts);
    const messages = {
      fail: "Cloudflare MX records are missing.",
      warning: "Cloudflare MX records coexist with another mail provider.",
      pass: "Cloudflare MX records are published.",
    };
    add(
      check,
      status,
      messages[status],
      status !== "pass"
        ? "Compare this name with the Email Service settings; preserve other mail services until their migration is planned."
        : undefined,
      name,
    );
  });
}

function mxStatus(hosts: string[]) {
  const required = [1, 2, 3].map((n) => `route${n}.mx.cloudflare.net`);
  if (!required.every((host) => hosts.includes(host))) return "fail";
  return hosts.some((host) => !required.includes(host)) ? "warning" : "pass";
}
async function checkSpf(ctx: DomainDiagnostics) {
  const { resolve, add, returnPath: spfName } = ctx;

  const records = (await resolve(spfName, "TXT")).filter((value) => /^v=spf1(?:\s|$)/i.test(value));
  if (records.length !== 1) {
    add(
      "spf",
      "fail",
      records.length ? "Multiple SPF records are published." : "Sending SPF is missing.",
      "Publish exactly one SPF record at the return-path domain; merge legitimate senders rather than adding a second SPF record.",
      spfName,
    );
    return;
  }
  const { safe, standard } = spfProfile(records[0]!);
  if (!safe) {
    add(
      "spf",
      "fail",
      "SPF does not safely authorize the Cloudflare sending profile.",
      "Compare with Cloudflare's expected SPF: v=spf1 include:_spf.mx.cloudflare.net ~all. Never use +all.",
      spfName,
    );
    return;
  }
  reportSpfProfile(ctx, standard);
}

function reportSpfProfile(ctx: DomainDiagnostics, standard: boolean) {
  ctx.add(
    "spf",
    standard ? "pass" : "warning",
    standard
      ? "SPF matches the Cloudflare sending profile."
      : "Custom SPF contains Cloudflare authorization; full evaluation is required.",
    standard
      ? undefined
      : "Check include/redirect expansion, syntax, ordering, and the ten DNS-lookup limit with an SPF evaluator.",
    ctx.returnPath,
  );
}

function spfProfile(record: string) {
  const terms = record.trim().split(/\s+/).slice(1);
  const profile = /^\+?include:_spf\.mx\.cloudflare\.net$/i;
  const include = terms.findIndex((term) => profile.test(term));
  const all = terms.findIndex((term) => /^[+?~-]?all$/i.test(term));
  const safe = !(
    include < 0 ||
    (all >= 0 && all < include) ||
    terms.some((term) => /^\+?all$/i.test(term))
  );
  const standard = terms.length === 2 && include === 0 && /^[~-]all$/i.test(terms[1]!);
  return { safe, standard };
}
export async function checkDomain(env: Env) {
  const checks: Check[] = [];
  const signal = AbortSignal.timeout(12_000);
  const domain = configuredDomain(env, checks);
  if (domain) {
    const ctx = new DomainDiagnostics(env, domain, signal, checks);
    await checkSending(ctx);
    await Promise.all([
      checkMx(ctx, ctx.returnPath, "bounce_mx"),
      checkMx(ctx, domain, "routing_mx"),
      ctx.run("spf", ctx.returnPath, () => checkSpf(ctx)),
      ctx.run("dkim", `${ctx.selector}._domainkey.${ctx.signingDomain}`, () => checkDkim(ctx)),
      ctx.run("dmarc", `_dmarc.${domain}`, () => checkDmarc(ctx)),
    ]);
    if (ctx.providerRecords) await checkProviderDns(ctx);
  }
  checks.sort((a, b) => a.id.localeCompare(b.id));
  const status = diagnosticStatus(checks);
  return {
    domain,
    checked_at: new Date().toISOString(),
    status,
    scope: "domain_configuration",
    delivery_verified: false,
    checks,
    limitations: [
      "DNS is observed through one recursive resolver; propagation and authoritative/global consistency are not proven.",
      "SPF checks the Cloudflare profile, not recursive SPF evaluation or the actual sending IP. DMARC checks explicit records only; inherited policies and report authorization are not evaluated.",
      "A published DKIM key does not verify a message signature. PTR, SMTP TLS, sender/IP reputation, complaints, content, actual alignment, delivery, and inbox placement need provider/recipient-side verification.",
    ],
  };
}

function configuredDomain(env: Env, checks: Check[]): string | null {
  try {
    const domain = z.hostname().max(253).parse(env.AGENTPOST_EMAIL_DOMAIN.toLowerCase());
    if (!domain.includes(".")) throw new Error("A public mail domain is required");
    return domain;
  } catch {
    checks.push({
      id: "domain",
      status: "fail",
      message: "The configured email domain is invalid.",
      remediation:
        "Set AGENTPOST_EMAIL_DOMAIN to your public ASCII domain (use punycode for IDNs).",
    });
    return null;
  }
}

function diagnosticStatus(checks: Check[]): Status {
  if (checks.some((check) => check.status === "fail")) return "fail";
  if (checks.some((check) => check.status === "unknown")) return "unknown";
  return checks.some((check) => check.status === "warning") ? "warning" : "pass";
}
