import { z } from "zod";
import { tags } from "./domain-context";
import type { DomainDiagnostics } from "./domain-context";
const policy = z.enum(["none", "quarantine", "reject"]);
export async function checkDkim(ctx: DomainDiagnostics) {
  const { resolve, add } = ctx;
  const dkimName = `${ctx.selector}._domainkey.${ctx.signingDomain}`;
  const records = await resolve(dkimName, "TXT");
  const record = dkimRecord(ctx, records, dkimName);
  if (!record) return;
  if (!validDkimProfile(record, records[0]!)) {
    add(
      "dkim",
      "fail",
      "The DKIM key is revoked or incompatible with the RSA/SHA-256 sending profile.",
      "Restore the currently active Cloudflare sending key.",
      dkimName,
    );
    return;
  }
  const key = await importDkimKey(ctx, record.p!, dkimName);
  if (!key) return;
  reportDkimStrength(ctx, key, record.t, dkimName);
}

function reportDkimStrength(
  ctx: DomainDiagnostics,
  key: CryptoKey,
  testing: string | undefined,
  dkimName: string,
) {
  const bits = z.object({ modulusLength: z.number().int() }).parse(key.algorithm).modulusLength;
  const warning = bits < 2048 || testing?.split(":").includes("y");
  ctx.add(
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
}

function dkimRecord(ctx: DomainDiagnostics, records: string[], dkimName: string) {
  const { add } = ctx;
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
  try {
    return tags(records[0]!);
  } catch {
    add(
      "dkim",
      "fail",
      "DKIM contains malformed or duplicate tags.",
      "Restore the active provider-managed DKIM public-key record.",
      dkimName,
    );
    return undefined;
  }
}

function permitsDkimTag(value: string | undefined, allowed: string[]): boolean {
  return value === undefined || value.split(":").some((tag) => allowed.includes(tag));
}
function validDkimVersion(value: string | undefined, raw: string): boolean {
  return value === undefined || (value === "DKIM1" && /^v\s*=/.test(raw.trim()));
}
function validDkimProfile(record: Record<string, string>, raw: string): boolean {
  return (
    validDkimVersion(record.v, raw) &&
    (record.k === undefined || record.k === "rsa") &&
    Boolean(record.p) &&
    permitsDkimTag(record.h, ["sha256"]) &&
    permitsDkimTag(record.s, ["*", "email"])
  );
}

async function importDkimKey(ctx: DomainDiagnostics, publicKey: string, dkimName: string) {
  const encoded = publicKey.replace(/[ \t]/g, "");
  try {
    if (!/^[a-zA-Z0-9+/]+={0,2}$/.test(encoded)) throw new Error("Invalid key encoding");
    return await crypto.subtle.importKey(
      "spki",
      Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0)),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
  } catch {
    ctx.add(
      "dkim",
      "fail",
      "The DKIM public key is not a usable RSA key.",
      "Copy the complete active public key from Cloudflare, preserving TXT chunk concatenation.",
      dkimName,
    );
    return undefined;
  }
}
export async function checkDmarc(ctx: DomainDiagnostics) {
  const { resolve, add, domain } = ctx;

  const records = (await resolve(`_dmarc.${domain}`, "TXT")).filter((value) =>
    /^v\s*=\s*DMARC1(?:\s*;|\s*$)/.test(value),
  );
  const record = dmarcRecord(ctx, records);
  if (!record) return;
  if (!validDmarcPolicy(record)) {
    add(
      "dmarc",
      "fail",
      "DMARC policy or alignment tags need review.",
      "Publish valid p, sp/np, aspf/adkim, t and psd values; begin with p=none while auditing legitimate senders.",
      `_dmarc.${domain}`,
    );
    return;
  }
  const monitoring = monitoringPolicy(record);
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
  checkReports(ctx, record);
  checkAlignment(ctx, record);
}

function monitoringPolicy(record: Record<string, string>): boolean {
  return (
    record.p === "none" || record.t === "y" || (record.pct !== undefined && record.pct !== "100")
  );
}

function dmarcRecord(ctx: DomainDiagnostics, records: string[]) {
  const { add, domain } = ctx;
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
  try {
    return tags(records[0]!);
  } catch {
    add(
      "dmarc",
      "fail",
      "DMARC contains malformed or duplicate tags.",
      "Review the explicit DMARC policy syntax.",
      `_dmarc.${domain}`,
    );
    return undefined;
  }
}

function validDmarcPolicy(record: Record<string, string>): boolean {
  return (
    policy.safeParse(record.p).success &&
    !["sp", "np"].some((tag) => record[tag] && !policy.safeParse(record[tag]).success) &&
    !["aspf", "adkim"].some((tag) => record[tag] && !["r", "s"].includes(record[tag]!)) &&
    !(record.t && !["y", "n"].includes(record.t)) &&
    !(record.psd && !["y", "n", "u"].includes(record.psd))
  );
}

function validReportUri(value: string): boolean {
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
}

function checkReports(ctx: DomainDiagnostics, record: Record<string, string>) {
  const { add } = ctx;
  const reportUris = (record.rua ?? "").split(",");
  const validReports = Boolean(record.rua) && reportUris.every(validReportUri);
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
}

function checkAlignment(ctx: DomainDiagnostics, record: Record<string, string>) {
  const { add, domain, returnPath, signingDomain } = ctx;
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
}
