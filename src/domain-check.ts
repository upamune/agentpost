import { z } from "zod";
import { diagnosticJson, dnsName, dnsTxt, publicDns } from "./domain-dns";
import type { Env } from "./types";

type Status = "pass" | "warning" | "fail" | "unknown";
interface Check {
  id: string;
  status: Status;
  message: string;
  remediation?: string;
  name?: string;
}
const policy = z.enum(["none", "quarantine", "reject"]);
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

function tags(record: string): Record<string, string> {
  if (/[^\x20-\x7e\t]/.test(record)) throw new Error("Invalid record characters");
  const result: Record<string, string> = Object.create(null);
  const parts = record.trim().replace(/;\s*$/, "").split(";");
  for (const part of parts) {
    const match = part.trim().match(/^([a-z][a-z0-9_]*)\s*=\s*(.*)$/i);
    if (!match || Object.hasOwn(result, match[1]!)) throw new Error("Invalid or duplicate tag");
    result[match[1]!] = match[2]!.trim();
  }
  return result;
}

export async function checkDomain(env: Env) {
  const checks: Check[] = [];
  const signal = AbortSignal.timeout(12_000);
  const resolve = publicDns(signal);
  const add = (id: string, status: Status, message: string, remediation?: string, name?: string) =>
    checks.push({
      id,
      status,
      message,
      ...(remediation ? { remediation } : {}),
      ...(name ? { name } : {}),
    });
  const run = async (id: string, name: string, operation: () => Promise<void>) => {
    try {
      await operation();
    } catch {
      add(
        id,
        "unknown",
        "Could not complete this check.",
        "Check resolver/API availability, permissions, and response compatibility; retry after DNS propagation.",
        name,
      );
    }
  };
  let domain: string | null = null;
  try {
    domain = z.hostname().max(253).parse(env.AGENTPOST_EMAIL_DOMAIN.toLowerCase());
    if (!domain.includes(".")) throw new Error("A public mail domain is required");
  } catch {
    domain = null;
    add(
      "domain",
      "fail",
      "The configured email domain is invalid.",
      "Set AGENTPOST_EMAIL_DOMAIN to your public ASCII domain (use punycode for IDNs).",
    );
  }
  if (domain) {
    let signingDomain = domain;
    let selector = "cf-bounce";
    let returnPath = `cf-bounce.${domain}`;
    let providerRecords: z.infer<typeof expectedDns>["result"] | undefined;
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
        const wildcard = details.name.startsWith("*.");
        const baseDomain = dnsName(wildcard ? details.name.slice(2) : details.name);
        if (
          details.tag !== row ||
          (wildcard ? !domain!.endsWith(`.${baseDomain}`) : baseDomain !== domain)
        ) {
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
        signingDomain = baseDomain;
        selector = nextSelector;
        returnPath = nextReturnPath;
        providerRecords = expected;
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
    const spfName = returnPath;
    const dkimName = `${selector}._domainkey.${signingDomain}`;
    const mx = async (name: string, check: string) =>
      run(check, name, async () => {
        const records = await resolve(name, "MX");
        const hosts = records.map((record) => {
          const match = record.match(/^\d{1,5}\s+(\S+)$/);
          if (!match) throw new Error("Invalid MX data");
          return match[1]!.toLowerCase().replace(/\.$/, "");
        });
        const required = [1, 2, 3].map((n) => `route${n}.mx.cloudflare.net`);
        const complete = required.every((host) => hosts.includes(host));
        const foreign = hosts.some((host) => !required.includes(host));
        add(
          check,
          !complete ? "fail" : foreign ? "warning" : "pass",
          !complete
            ? "Cloudflare MX records are missing."
            : foreign
              ? "Cloudflare MX records coexist with another mail provider."
              : "Cloudflare MX records are published.",
          !complete || foreign
            ? "Compare this name with the Email Service settings; preserve other mail services until their migration is planned."
            : undefined,
          name,
        );
      });
    await Promise.all([
      mx(returnPath, "bounce_mx"),
      mx(domain, "routing_mx"),
      run("spf", spfName, async () => {
        const records = (await resolve(spfName, "TXT")).filter((value) =>
          /^v=spf1(?:\s|$)/i.test(value),
        );
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
        const terms = records[0]!.trim().split(/\s+/).slice(1);
        const profile = /^\+?include:_spf\.mx\.cloudflare\.net$/i;
        const include = terms.findIndex((term) => profile.test(term));
        const all = terms.findIndex((term) => /^[+?~-]?all$/i.test(term));
        if (
          include < 0 ||
          (all >= 0 && all < include) ||
          terms.some((term) => /^\+?all$/i.test(term))
        ) {
          add(
            "spf",
            "fail",
            "SPF does not safely authorize the Cloudflare sending profile.",
            "Compare with Cloudflare's expected SPF: v=spf1 include:_spf.mx.cloudflare.net ~all. Never use +all.",
            spfName,
          );
          return;
        }
        const standard = terms.length === 2 && include === 0 && /^[~-]all$/i.test(terms[1]!);
        add(
          "spf",
          standard ? "pass" : "warning",
          standard
            ? "SPF matches the Cloudflare sending profile."
            : "Custom SPF contains Cloudflare authorization; full evaluation is required.",
          standard
            ? undefined
            : "Check include/redirect expansion, syntax, ordering, and the ten DNS-lookup limit with an SPF evaluator.",
          spfName,
        );
      }),
      run("dkim", dkimName, async () => {
        const records = await resolve(dkimName, "TXT");
        if (records.length !== 1) {
          add(
            "dkim",
            "fail",
            "Sending DKIM is missing or ambiguous.",
            "Restore the sending selector's exact public key from Cloudflare Email Sending; the Email Routing selector is different.",
            dkimName,
          );
          return;
        }
        let record: Record<string, string>;
        try {
          record = tags(records[0]!);
        } catch {
          add(
            "dkim",
            "fail",
            "DKIM contains malformed or duplicate tags.",
            "Restore the active provider-managed DKIM public-key record.",
            dkimName,
          );
          return;
        }
        if (
          (record.v !== undefined &&
            (record.v !== "DKIM1" || !/^v\s*=/.test(records[0]!.trim()))) ||
          (record.k !== undefined && record.k !== "rsa") ||
          !record.p ||
          (record.h !== undefined && !record.h.split(":").includes("sha256")) ||
          (record.s !== undefined &&
            !record.s.split(":").some((value) => value === "*" || value === "email"))
        ) {
          add(
            "dkim",
            "fail",
            "The DKIM key is revoked or incompatible with the RSA/SHA-256 sending profile.",
            "Restore the currently active Cloudflare sending key.",
            dkimName,
          );
          return;
        }
        const encoded = record.p.replace(/[ \t]/g, "");
        let key: CryptoKey;
        try {
          if (!/^[a-zA-Z0-9+/]+={0,2}$/.test(encoded)) throw new Error("Invalid key encoding");
          key = await crypto.subtle.importKey(
            "spki",
            Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0)),
            { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
            false,
            ["verify"],
          );
        } catch {
          add(
            "dkim",
            "fail",
            "The DKIM public key is not a usable RSA key.",
            "Copy the complete active public key from Cloudflare, preserving TXT chunk concatenation.",
            dkimName,
          );
          return;
        }
        const bits = z
          .object({ modulusLength: z.number().int() })
          .parse(key.algorithm).modulusLength;
        const warning = bits < 2048 || record.t?.split(":").includes("y");
        add(
          "dkim",
          bits < 1024 ? "fail" : warning ? "warning" : "pass",
          bits < 1024
            ? "DKIM RSA key is shorter than 1024 bits."
            : warning
              ? "DKIM uses a short key or testing mode."
              : "A usable RSA DKIM public key is published.",
          warning
            ? "Prefer an active 2048-bit or stronger provider-managed key outside testing mode."
            : undefined,
          dkimName,
        );
      }),
      run("dmarc", `_dmarc.${domain}`, async () => {
        const records = (await resolve(`_dmarc.${domain}`, "TXT")).filter((value) =>
          /^v\s*=\s*DMARC1(?:\s*;|\s*$)/.test(value),
        );
        if (records.length !== 1) {
          add(
            "dmarc",
            records.length ? "fail" : "unknown",
            records.length
              ? "Multiple explicit DMARC records are published."
              : "No explicit DMARC record was found at the From domain.",
            records.length
              ? "Publish one DMARC policy record."
              : "An inherited policy may apply; this diagnostic does not evaluate parent/PSD discovery. Prefer an explicit policy at each From domain and verify inheritance with a DMARC evaluator.",
            `_dmarc.${domain}`,
          );
          return;
        }
        let record: Record<string, string>;
        try {
          record = tags(records[0]!);
        } catch {
          add(
            "dmarc",
            "fail",
            "DMARC contains malformed or duplicate tags.",
            "Review the explicit DMARC policy syntax.",
            `_dmarc.${domain}`,
          );
          return;
        }
        const parsed = policy.safeParse(record.p);
        if (
          !parsed.success ||
          ["sp", "np"].some((tag) => record[tag] && !policy.safeParse(record[tag]).success) ||
          ["aspf", "adkim"].some((tag) => record[tag] && !["r", "s"].includes(record[tag]!)) ||
          (record.t && !["y", "n"].includes(record.t)) ||
          (record.psd && !["y", "n", "u"].includes(record.psd))
        ) {
          add(
            "dmarc",
            "fail",
            "DMARC policy or alignment tags need review.",
            "Publish valid p, sp/np, aspf/adkim, t and psd values; begin with p=none while auditing legitimate senders.",
            `_dmarc.${domain}`,
          );
          return;
        }
        const monitoring =
          parsed.data === "none" ||
          record.t === "y" ||
          (record.pct !== undefined && record.pct !== "100");
        add(
          "dmarc",
          monitoring ? "warning" : "pass",
          monitoring
            ? "DMARC is present in monitoring, testing, or partial-enforcement mode."
            : "An explicit DMARC enforcement policy is published.",
          monitoring
            ? "Review authenticated mail and reports before increasing enforcement; p=none is valid during rollout."
            : undefined,
          `_dmarc.${domain}`,
        );
        const reportUris = (record.rua ?? "").split(",");
        const validReports =
          Boolean(record.rua) &&
          reportUris.every((value) => {
            try {
              const uri = new URL(value.trim().replace(/!\d+[kmgt]?$/i, ""));
              return (
                uri.protocol === "mailto:" &&
                !uri.search &&
                !uri.hash &&
                z.email().safeParse(decodeURIComponent(uri.pathname)).success
              );
            } catch {
              return false;
            }
          });
        add(
          "dmarc_reports",
          validReports ? "pass" : "warning",
          validReports
            ? "DMARC aggregate-report mailto syntax is plausible; authorization and reachability are unverified."
            : record.rua
              ? "DMARC aggregate-report URIs need review or use an unsupported scheme."
              : "DMARC has no aggregate-report destination.",
          validReports
            ? undefined
            : "Configure valid monitored aggregate-report URIs; check external reporting authorization separately.",
        );
        if (record.aspf === "s" && returnPath !== domain)
          add(
            "alignment",
            "warning",
            "Strict SPF alignment excludes the configured return-path domain.",
            "Confirm aligned DKIM in a received test message; do not tighten DMARC until legitimate mail passes.",
          );
        if (record.adkim === "s" && signingDomain !== domain)
          add(
            "dkim_alignment",
            "warning",
            "Strict DKIM alignment excludes the configured signing domain.",
            "Review wildcard signing and DMARC alignment using received-message authentication results.",
          );
      }),
    ]);
    if (providerRecords) {
      await run("cloudflare_dns", domain, async () => {
        const expected = providerRecords!
          .filter(
            (record) =>
              ["MX", "TXT"].includes(record.type) &&
              !record.name.toLowerCase().startsWith("_dmarc."),
          )
          .map((record) => ({
            ...record,
            // The provider returns DNS presentation strings, including quoted TXT chunks.
            content:
              record.type === "TXT" && record.content.trimStart().startsWith('"')
                ? dnsTxt(record.content)
                : record.content,
          }));
        let mismatch = false;
        let custom = false;
        if (
          ![returnPath, dkimName].every((name) =>
            expected.some((record) => dnsName(record.name) === name && record.type === "TXT"),
          ) ||
          !expected.some((record) => dnsName(record.name) === returnPath && record.type === "MX")
        )
          throw new Error("Incomplete expected sending DNS");
        for (const record of expected) {
          const name = dnsName(record.name);
          if (!name.endsWith(`.${signingDomain}`) && name !== signingDomain)
            throw new Error("Unexpected expected DNS name");
          const values = await resolve(name, record.type === "TXT" ? "TXT" : "MX");
          if (record.type === "MX" && record.priority === undefined)
            throw new Error("Missing MX priority");
          if (record.type === "TXT" && name === dkimName) {
            const wantedKey = tags(record.content).p?.replace(/[ \t]/g, "");
            if (!wantedKey) throw new Error("Missing expected DKIM key");
            if (
              !values.some((value) => {
                try {
                  return tags(value).p?.replace(/[ \t]/g, "") === wantedKey;
                } catch {
                  return false;
                }
              })
            )
              mismatch = true;
          } else if (record.type === "TXT" && /^v=spf1(?:\s|$)/i.test(record.content)) {
            const normalize = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();
            if (!values.some((value) => normalize(value) === normalize(record.content)))
              custom = true;
            if (!values.some((value) => /^v=spf1(?:\s|$)/i.test(value))) mismatch = true;
          } else if (record.type === "MX") {
            const host = record.content.toLowerCase().replace(/\.$/, "");
            const wanted = `${record.priority} ${host}`;
            if (!values.some((value) => value.toLowerCase().replace(/\.$/, "") === wanted))
              custom = true;
            if (
              !values.some(
                (value) => value.toLowerCase().replace(/\.$/, "").split(/\s+/)[1] === host,
              )
            )
              mismatch = true;
          } else if (!values.includes(record.content)) mismatch = true;
        }
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
  }
  checks.sort((a, b) => a.id.localeCompare(b.id));
  const status: Status = checks.some((check) => check.status === "fail")
    ? "fail"
    : checks.some((check) => check.status === "unknown")
      ? "unknown"
      : checks.some((check) => check.status === "warning")
        ? "warning"
        : "pass";
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
