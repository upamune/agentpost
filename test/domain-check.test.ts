import { applyD1Migrations, createExecutionContext, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, afterEach, expect, test, vi } from "vitest";
import { exportJWK, exportSPKI, generateKeyPair, SignJWT } from "jose";
import { checkDomain } from "../src/domain-check";
import worker from "../src/index";
import type { Env } from "../src/types";

const bindings: Env = env;
const admin = "test-admin-token-with-at-least-32-characters";
const domain = "example.com";
const zone = "a".repeat(32);
const row = "b".repeat(32);
const token = "diagnostic-fixture-".repeat(3);
const settings: Env = {
  ...bindings,
  AGENTPOST_CF_ZONE_ID: zone,
  AGENTPOST_CF_SENDING_SUBDOMAIN_ID: row,
  AGENTPOST_CF_DIAGNOSTICS_API_TOKEN: token,
};
const mx = [1, 2, 3].map((n) => `${n * 10} route${n}.mx.cloudflare.net.`);
let key: string;
let records: Map<string, string[]>;
let calls: { url: URL; init?: RequestInit }[];
let details: Record<string, unknown>;
let expected: Record<string, unknown>[];
let overrides: ((url: URL, init?: RequestInit) => Response | undefined) | undefined;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  key = (await exportSPKI(pair.publicKey)).replace(/-----[^-]+-----|\s/g, "");
});
beforeEach(async () => {
  await reset();
  await applyD1Migrations(bindings.DB, env.TEST_MIGRATIONS);
  calls = [];
  overrides = undefined;
  records = new Map([
    [`cf-bounce.${domain}:TXT`, ["v=spf1 include:_spf.mx.cloudflare.net ~all"]],
    [`cf-bounce._domainkey.${domain}:TXT`, [`v=DKIM1; k=rsa; p=${key}`]],
    [`_dmarc.${domain}:TXT`, ["v=DMARC1; p=reject; rua=mailto:dmarc@example.com"]],
    [`cf-bounce.${domain}:MX`, mx],
    [`${domain}:MX`, mx],
  ]);
  details = {
    enabled: true,
    name: domain,
    tag: row,
    dkim_selector: "cf-bounce",
    return_path_domain: `cf-bounce.${domain}`,
  };
  expected = [
    {
      name: `cf-bounce.${domain}`,
      type: "TXT",
      content: "v=spf1 include:_spf.mx.cloudflare.net ~all",
    },
    { name: `cf-bounce._domainkey.${domain}`, type: "TXT", content: `v=DKIM1; k=rsa; p=${key}` },
    ...[1, 2, 3].map((n) => ({
      name: `cf-bounce.${domain}`,
      type: "MX",
      content: `route${n}.mx.cloudflare.net`,
      priority: n * 10,
    })),
    { name: `_dmarc.${domain}`, type: "TXT", content: "v=DMARC1; p=reject;" },
  ];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    // Preserve workerd's Request validation even when upstream responses are mocked.
    new Request(input, init);
    const url = new URL(String(input));
    calls.push({ url, init });
    const override = overrides?.(url, init);
    if (override) return override;
    if (url.origin === "https://api.cloudflare.com") {
      if (url.pathname === `/client/v4/zones/${zone}/email/sending/subdomains/${row}`)
        return Response.json({ success: true, result: details });
      if (url.pathname === `/client/v4/zones/${zone}/email/sending/subdomains/${row}/dns`)
        return Response.json({ success: true, result: expected });
    }
    if (url.origin !== "https://cloudflare-dns.com" || url.pathname !== "/dns-query")
      throw new Error("Unexpected diagnostic egress");
    const name = url.searchParams.get("name")!;
    const type = url.searchParams.get("type")!;
    const values = records.get(`${name}:${type}`) ?? [];
    return Response.json({
      Status: 0,
      TC: false,
      Question: [{ name: `${name}.`, type: type === "TXT" ? 16 : 15 }],
      Answer: values.map((value) => ({
        name: `${name}.`,
        type: type === "TXT" ? 16 : 15,
        data: type === "TXT" ? JSON.stringify(value) : value,
      })),
    });
  });
});
afterEach(() => vi.restoreAllMocks());

function status(report: Awaited<ReturnType<typeof checkDomain>>, id: string) {
  return report.checks.find((check) => check.id === id)?.status;
}
async function api(token = admin, vars = settings) {
  return worker.fetch(
    new Request("https://mail.test/v1/domain/check?domain=attacker.invalid", {
      headers: { Authorization: `Bearer ${token}` },
    }),
    vars,
    createExecutionContext(),
  );
}

test("checks the configured domain, provider expected records, and distinct sending/routing DNS without writes or mail", async () => {
  const response = await api();
  expect(response.status).toBe(200);
  const report = await response.json<Awaited<ReturnType<typeof checkDomain>>>();
  expect(report).toMatchObject({
    domain,
    status: "pass",
    scope: "domain_configuration",
    delivery_verified: false,
  });
  expect(report.checks.map((check) => check.id)).toEqual([
    "bounce_mx",
    "cloudflare_dns",
    "cloudflare_sending",
    "dkim",
    "dmarc",
    "dmarc_reports",
    "routing_mx",
    "spf",
  ]);
  expect(calls).toHaveLength(7);
  for (const call of calls) {
    expect(call.init?.method ?? "GET").toBe("GET");
    expect(call.init?.body).toBeUndefined();
    expect(call.init?.redirect).toBe("manual");
    expect(call.init?.signal).toBeInstanceOf(AbortSignal);
    const authorization = new Headers(call.init?.headers).get("Authorization");
    expect(authorization).toBe(
      call.url.origin === "https://api.cloudflare.com" ? `Bearer ${token}` : null,
    );
    expect(call.url.href).not.toContain("attacker.invalid");
  }
  expect(JSON.stringify(report)).not.toContain(token);
  expect(JSON.stringify(report)).not.toContain(key);
});

test("DNS remains available without provider credentials and does not infer onboarding or delivery", async () => {
  const report = await checkDomain(bindings);
  expect(report.status).toBe("unknown");
  expect(status(report, "cloudflare_sending")).toBe("unknown");
  expect(status(report, "spf")).toBe("pass");
  expect(calls.every((call) => call.url.hostname === "cloudflare-dns.com")).toBe(true);
  expect(report.delivery_verified).toBe(false);
});

test("admin token and OAuth admin may diagnose; inbox tokens and OAuth agents cannot trigger external lookups", async () => {
  const created = await worker.fetch(
    new Request("https://mail.test/v1/inboxes", {
      method: "POST",
      headers: { Authorization: `Bearer ${admin}`, "Content-Type": "application/json" },
      body: "{}",
    }),
    bindings,
    createExecutionContext(),
  );
  const box = await created.json<{ token: string }>();
  expect((await api(box.token)).status).toBe(403);
  expect((await api("bad-token")).status).toBe(401);
  expect(calls).toHaveLength(0);
  const pair = await generateKeyPair("RS256");
  const issuer = "https://domain-diagnostics.cloudflareaccess.com";
  const audience = "c".repeat(64);
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: "test-key", alg: "RS256", use: "sig" };
  overrides = (url) =>
    url.href === `${issuer}/cdn-cgi/access/certs` ? Response.json({ keys: [jwk] }) : undefined;
  const oauth: Env = {
    ...settings,
    AGENTPOST_AUTH_MODE: "oauth",
    AGENTPOST_ADMIN_TOKEN: undefined,
    AGENTPOST_CURSOR_KEY: "test-cursor-".repeat(4),
    AGENTPOST_ACCESS_TEAM_DOMAIN: issuer,
    AGENTPOST_ACCESS_AUD: audience,
    AGENTPOST_ACCESS_PRINCIPALS: JSON.stringify({
      "user:alice": "agent",
      "user:operator": "admin",
    }),
    AGENTPOST_OAUTH_RESOURCE_URL: "https://mail.test/mcp",
    AGENTPOST_OAUTH_AUTHORIZATION_SERVER: "https://login.test",
  };
  for (const subject of ["alice", "operator"]) {
    const assertion = await new SignJWT({ type: "app" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setSubject(subject)
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(pair.privateKey);
    const before = calls.length;
    const response = await worker.fetch(
      new Request("https://mail.test/v1/domain/check", {
        headers: { "Cf-Access-Jwt-Assertion": assertion },
      }),
      oauth,
      createExecutionContext(),
    );
    expect(response.status).toBe(subject === "alice" ? 403 : 200);
    if (subject === "alice")
      expect(
        calls.slice(before).every((call) => call.url.href === `${issuer}/cdn-cgi/access/certs`),
      ).toBe(true);
  }
});

test("missing or duplicate SPF and permissive/unreachable authorization fail rather than passing root SPF", async () => {
  records.set(`${domain}:TXT`, ["v=spf1 include:_spf.mx.cloudflare.net ~all"]);
  for (const values of [
    [],
    ["v=spf1 include:_spf.mx.cloudflare.net ~all", "v=spf1 -all"],
    ["v=spf1 +all include:_spf.mx.cloudflare.net"],
    ["v=spf1 -all include:_spf.mx.cloudflare.net"],
    ["v=spf1 include:other.test -all"],
  ]) {
    records.set(`cf-bounce.${domain}:TXT`, values);
    expect(status(await checkDomain(bindings), "spf")).toBe("fail");
  }
  records.set(`cf-bounce.${domain}:TXT`, ["v=spf1 a include:_spf.mx.cloudflare.net -all"]);
  expect(status(await checkDomain(bindings), "spf")).toBe("warning");
});

test("missing, revoked, malformed, ambiguous or routing-only DKIM cannot pass sending DKIM", async () => {
  records.set(`cf2024-1._domainkey.${domain}:TXT`, [`v=DKIM1; p=${key}`]);
  for (const values of [
    [],
    ["v=DKIM1; p="],
    ["v=DKIM1; p=AAAA"],
    ["v=DKIM1; p=not%base64"],
    [`v=DKIM1; p=${key}; p=AAAA`],
    [`k=rsa; v=DKIM1; p=${key}`],
    [`v=; p=${key}`],
    [`v=DKIM1; p=${key}`, "v=DKIM1; p=AAAA"],
    [`v=DKIM1; h=sha1; p=${key}`],
  ]) {
    records.set(`cf-bounce._domainkey.${domain}:TXT`, values);
    expect(status(await checkDomain(bindings), "dkim")).toBe("fail");
  }
  records.set(`cf-bounce._domainkey.${domain}:TXT`, [`v=DKIM1; t=y; p=${key}`]);
  expect(status(await checkDomain(bindings), "dkim")).toBe("warning");
});

test("DMARC rollout, duplicate tags, inheritance uncertainty and strict SPF alignment are distinguished", async () => {
  records.set(`_dmarc.${domain}:TXT`, ["v=DMARC1; p=none"]);
  let report = await checkDomain(bindings);
  expect(status(report, "dmarc")).toBe("warning");
  expect(status(report, "dmarc_reports")).toBe("warning");
  for (const values of [
    ["v=DMARC1; p=reject; p=none"],
    ["v=DMARC1; p=reject", "v=DMARC1; p=none"],
    ["v=DMARC1; p=invalid"],
    ["v=DMARC1; p=reject; aspf=x"],
  ]) {
    records.set(`_dmarc.${domain}:TXT`, values);
    expect(status(await checkDomain(bindings), "dmarc")).toBe("fail");
  }
  records.delete(`_dmarc.${domain}:TXT`);
  expect(status(await checkDomain(bindings), "dmarc")).toBe("unknown");
  records.set(`_dmarc.${domain}:TXT`, ["v=DMARC1; p=reject; aspf=s; rua=mailto:dmarc@example.com"]);
  report = await checkDomain(bindings);
  expect(status(report, "alignment")).toBe("warning");
});

test("partial provider settings and disabled or unrelated sending-domain rows never pass", async () => {
  let report = await checkDomain({ ...settings, AGENTPOST_CF_DIAGNOSTICS_API_TOKEN: undefined });
  expect(status(report, "cloudflare_sending")).toBe("unknown");
  expect(calls.every((call) => call.url.hostname === "cloudflare-dns.com")).toBe(true);
  details.enabled = false;
  expect(status(await checkDomain(settings), "cloudflare_sending")).toBe("fail");
  details.name = "attacker.invalid";
  expect(status(await checkDomain(settings), "cloudflare_sending")).toBe("fail");
  expect(calls.some((call) => call.url.search.includes("attacker.invalid"))).toBe(false);
});

test("provider selectors and return paths are used and a stale but valid DKIM key fails the provider comparison", async () => {
  details.dkim_selector = "active-2026";
  records.set(`active-2026._domainkey.${domain}:TXT`, [`v=DKIM1; k=rsa; p=${key}`]);
  expected[1] = {
    name: `active-2026._domainkey.${domain}`,
    type: "TXT",
    content: "v=DKIM1; k=rsa; p=AAAA",
  };
  const report = await checkDomain(settings);
  expect(status(report, "dkim")).toBe("pass");
  expect(status(report, "cloudflare_dns")).toBe("fail");
  expect(report.checks.find((check) => check.id === "dkim")?.name).toBe(
    `active-2026._domainkey.${domain}`,
  );
});

test("provider TXT values use DNS quoted strings and chunks without causing unknown diagnostics", async () => {
  expected = expected.map((record) =>
    record.type === "TXT" ? { ...record, content: JSON.stringify(record.content) } : record,
  );
  expected[1]!.content = `"v=DKIM1; k=rsa; p=" "${key}"`;
  expect(status(await checkDomain(settings), "cloudflare_dns")).toBe("pass");
  expected[1]!.content = '"v=DKIM1; k=rsa; p=AAAA"';
  expect(status(await checkDomain(settings), "cloudflare_dns")).toBe("fail");
  for (const malformed of ['"unclosed', '"v=DKIM1;"junk', '"bad\\999"']) {
    expected[1]!.content = malformed;
    expect(status(await checkDomain(settings), "cloudflare_dns")).toBe("unknown");
  }
});

test("TXT chunks concatenate within one RR and DNS CNAMEs are followed only within the returned answer chain", async () => {
  overrides = (url) => {
    if (
      url.hostname !== "cloudflare-dns.com" ||
      url.searchParams.get("name") !== `cf-bounce._domainkey.${domain}`
    )
      return;
    return Response.json({
      Status: 0,
      TC: false,
      Question: [{ name: `cf-bounce._domainkey.${domain}.`, type: 16 }],
      Answer: [
        { name: `cf-bounce._domainkey.${domain}.`, type: 5, data: "active.provider.test." },
        { name: "active.provider.test.", type: 16, data: `"v=DKIM1; k=rsa; p=" "${key}"` },
      ],
    });
  };
  expect(status(await checkDomain(settings), "dkim")).toBe("pass");
  expect(
    calls.every((call) => ["api.cloudflare.com", "cloudflare-dns.com"].includes(call.url.hostname)),
  ).toBe(true);
});

test("unrelated injected DNS answers cannot satisfy a missing SPF record", async () => {
  overrides = (url) =>
    url.searchParams.get("name") === `cf-bounce.${domain}` && url.searchParams.get("type") === "TXT"
      ? Response.json({
          Status: 0,
          TC: false,
          Question: [{ name: `cf-bounce.${domain}.`, type: 16 }],
          Answer: [
            {
              name: "attacker.invalid.",
              type: 16,
              data: '"v=spf1 include:_spf.mx.cloudflare.net ~all"',
            },
          ],
        })
      : undefined;
  expect(status(await checkDomain(bindings), "spf")).toBe("fail");
});

test("DNS errors, truncation, question mismatch, malformed/oversized JSON and upstream errors remain unknown without reflecting secrets", async () => {
  for (const result of [
    () =>
      Response.json({
        Status: 2,
        TC: false,
        Question: [{ name: `cf-bounce.${domain}`, type: 16 }],
      }),
    () =>
      Response.json({ Status: 0, TC: true, Question: [{ name: `cf-bounce.${domain}`, type: 16 }] }),
    () =>
      Response.json({ Status: 0, TC: false, Question: [{ name: "attacker.invalid", type: 16 }] }),
    () => Response.json({ secret: token }),
    () => new Response(" ".repeat(256 * 1024 + 1)),
    () => new Response(token, { status: 503 }),
    () =>
      new Response(null, {
        status: 302,
        headers: { Location: `https://attacker.invalid/${token}` },
      }),
  ]) {
    overrides = (url) =>
      url.searchParams.get("name") === `cf-bounce.${domain}` &&
      url.searchParams.get("type") === "TXT"
        ? result()
        : undefined;
    const report = await checkDomain(bindings);
    expect(status(report, "spf")).toBe("unknown");
    expect(JSON.stringify(report)).not.toContain(token);
    expect(JSON.stringify(report)).not.toContain("attacker.invalid");
  }
});

test("invalid configured domains do not trigger DNS or provider calls", async () => {
  for (const value of [
    "localhost",
    "https://attacker.invalid",
    "example.com/path",
    "example.com\n",
    "bad_domain.example",
  ]) {
    const report = await checkDomain({ ...settings, AGENTPOST_EMAIL_DOMAIN: value });
    expect(report.status).toBe("fail");
    expect(calls).toHaveLength(0);
  }
});

test("wildcard sending uses the base signing domain and flags strict DKIM alignment", async () => {
  const mailDomain = `agent.${domain}`;
  details.name = `*.${domain}`;
  records.set(`${mailDomain}:MX`, mx);
  records.set(`_dmarc.${mailDomain}:TXT`, [
    "v=DMARC1; p=reject; adkim=s; rua=mailto:dmarc@example.com",
  ]);
  const report = await checkDomain({ ...settings, AGENTPOST_EMAIL_DOMAIN: mailDomain });
  expect(status(report, "cloudflare_sending")).toBe("pass");
  expect(status(report, "cloudflare_dns")).toBe("pass");
  expect(status(report, "dkim")).toBe("pass");
  expect(status(report, "dkim_alignment")).toBe("warning");
  expect(report.checks.find((check) => check.id === "dkim")?.name).toBe(
    `cf-bounce._domainkey.${domain}`,
  );
});

test("provider errors, redirects, malformed expectations and path-like IDs cannot leak credentials or claim verification", async () => {
  for (const response of [
    () => new Response(token, { status: 403 }),
    () =>
      new Response(null, {
        status: 302,
        headers: { Location: `https://attacker.invalid/${token}` },
      }),
    () => Response.json({ success: false, errors: [{ message: token }] }),
  ]) {
    overrides = (url) => (url.hostname === "api.cloudflare.com" ? response() : undefined);
    const report = await checkDomain(settings);
    expect(status(report, "cloudflare_sending")).toBe("unknown");
    expect(JSON.stringify(report)).not.toContain(token);
    expect(JSON.stringify(report)).not.toContain("attacker.invalid");
  }
  overrides = undefined;
  expected = [
    { name: `cf-bounce.${domain}`, type: "MX", content: "route1.mx.cloudflare.net", priority: 10 },
  ];
  expect(status(await checkDomain(settings), "cloudflare_dns")).toBe("unknown");
  calls = [];
  expect(
    status(
      await checkDomain({ ...settings, AGENTPOST_CF_ZONE_ID: `${zone}/../../other` }),
      "cloudflare_sending",
    ),
  ).toBe("unknown");
  expect(calls.every((call) => call.url.hostname === "cloudflare-dns.com")).toBe(true);
});

test("alias loops, missing alias targets and invalid TXT encodings stay unknown", async () => {
  const name = `cf-bounce.${domain}`;
  for (const answers of [
    [{ name, type: 5, data: `${name}.` }],
    [{ name, type: 5, data: "missing.target.test." }],
    [{ name, type: 16, data: '"v=spf1 include:_spf.mx.cloudflare.net ~all' }],
    [{ name, type: 16, data: '"v=spf1 include:_spf.mx.cloudflare.net ~all"garbage' }],
  ]) {
    overrides = (url) =>
      url.searchParams.get("name") === name && url.searchParams.get("type") === "TXT"
        ? Response.json({ Status: 0, TC: false, Question: [{ name, type: 16 }], Answer: answers })
        : undefined;
    expect(status(await checkDomain(bindings), "spf")).toBe("unknown");
  }
  overrides = (url) =>
    url.searchParams.get("name") === name && url.searchParams.get("type") === "TXT"
      ? Response.json({
          Status: 0,
          TC: false,
          Question: [{ name, type: 16 }],
          Answer: [{ name, type: 16, data: '"v=spf1\\032" "include:_spf.mx.cloudflare.net ~all"' }],
        })
      : undefined;
  expect(status(await checkDomain(bindings), "spf")).toBe("pass");
});

test("custom SPF and MX priorities warn without falsely reporting a stale DKIM key", async () => {
  records.set(`cf-bounce.${domain}:TXT`, ["v=spf1 a include:_spf.mx.cloudflare.net ~all"]);
  records.set(`cf-bounce.${domain}:MX`, ["99 route1.mx.cloudflare.net.", ...mx.slice(1)]);
  records.set(`cf-bounce._domainkey.${domain}:TXT`, [`k=rsa; p=${key}`]);
  const report = await checkDomain(settings);
  expect(status(report, "cloudflare_dns")).toBe("warning");
  expect(status(report, "dkim")).toBe("pass");
  expect(status(report, "spf")).toBe("warning");
});
