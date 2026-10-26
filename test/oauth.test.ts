import { applyD1Migrations, createExecutionContext, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { OAuthClientProvider, StoredOAuthTokens } from "@modelcontextprotocol/client";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { JWTPayload } from "jose";
import { beforeAll, beforeEach, afterEach, expect, test, vi } from "vitest";
import { z } from "zod";
import worker from "../src/index";
import type { Env } from "../src/types";
import { eventPollPageSchema } from "../src/event-schema";

const bindings: Env = env;
const adminToken = "test-admin-token-with-at-least-32-characters";
const issuer = "https://test-oauth.cloudflareaccess.com";
const aud = "a".repeat(64);
const oauth: Env = {
  ...bindings,
  AGENTPOST_AUTH_MODE: "oauth",
  AGENTPOST_ADMIN_TOKEN: undefined,
  AGENTPOST_CURSOR_KEY: "test-cursor-".repeat(4),
  AGENTPOST_ACCESS_TEAM_DOMAIN: issuer,
  AGENTPOST_ACCESS_AUD: aud,
  AGENTPOST_ACCESS_PRINCIPALS: JSON.stringify({
    "user:alice": "agent",
    "user:bob": "agent",
    "user:operator": "admin",
    "service:machine.access": "agent",
  }),
  AGENTPOST_OAUTH_RESOURCE_URL: "https://mail.test/mcp",
  AGENTPOST_OAUTH_AUTHORIZATION_SERVER: "https://login.test",
};
let privateKey: CryptoKey;
let wrongKey: CryptoKey;
let publicJwk: Awaited<ReturnType<typeof exportJWK>>;
let keyRequests: string[];

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: "test-key", alg: "RS256", use: "sig" };
  wrongKey = (await generateKeyPair("RS256")).privateKey;
});
beforeEach(async () => {
  await reset();
  await applyD1Migrations(bindings.DB, env.TEST_MIGRATIONS);
  keyRequests = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    // Exercise edge Request constraints instead of accepting unsupported fetch options.
    new Request(input, init);
    const url = String(input);
    keyRequests.push(url);
    if (url === `${issuer}/cdn-cgi/access/certs`) return Response.json({ keys: [publicJwk] });
    throw new Error("Unexpected key fetch; synthetic private upstream details");
  });
});
afterEach(() => vi.restoreAllMocks());

async function jwt(sub = "alice", extra: JWTPayload = {}, key = privateKey) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: issuer,
    aud: [aud],
    sub,
    type: "app",
    iat: now,
    exp: now + 600,
    ...extra,
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .sign(key);
}
async function api(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    assertion?: string;
    token?: string;
    key?: string;
    settings?: Env;
  } = {},
) {
  return worker.fetch(
    new Request(`https://mail.test${path}`, {
      method: options.method ?? "GET",
      headers: {
        ...(options.assertion === undefined
          ? {}
          : { "Cf-Access-Jwt-Assertion": options.assertion }),
        ...(options.token === undefined ? {} : { Authorization: `Bearer ${options.token}` }),
        ...(options.key === undefined ? {} : { "Idempotency-Key": options.key }),
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    }),
    options.settings ?? oauth,
    createExecutionContext(),
  );
}
async function create(sub = "alice", settings = oauth) {
  const response = await api("/v1/inboxes", {
    method: "POST",
    body: {},
    assertion: await jwt(sub),
    settings,
  });
  expect(response.status).toBe(201);
  return response.json<{ id: string; address: string; token?: string }>();
}
async function poll(
  assertion: string,
  inbox: string,
  cursor: string | null = null,
  settings = oauth,
) {
  return api("/v1/events/poll", {
    method: "POST",
    body: { name: "message.received", arguments: { inbox_id: inbox }, cursor },
    assertion,
    settings,
  });
}

test("OAuth-only needs no admin token and advertises canonical protected-resource discovery", async () => {
  const response = await api("/mcp");
  expect(response.status).toBe(401);
  expect(response.headers.get("WWW-Authenticate")).toBe(
    'Bearer resource_metadata="https://mail.test/.well-known/oauth-protected-resource/mcp"',
  );
  const discovery = await api("/.well-known/oauth-protected-resource/mcp");
  expect(discovery.status).toBe(200);
  expect(await discovery.json()).toEqual({
    resource: "https://mail.test/mcp",
    authorization_servers: ["https://login.test"],
    resource_name: "agentpost",
    bearer_methods_supported: ["header"],
  });
  expect((await api("/.well-known/oauth-protected-resource")).status).toBe(200);
  expect(
    (await api("/.well-known/oauth-protected-resource/mcp", { method: "POST", body: {} })).status,
  ).toBe(405);
  expect((await api("/v1/inboxes", { token: adminToken })).status).toBe(401);
  expect((await create()).token).toBeUndefined();
  expect(
    (await api("/.well-known/oauth-protected-resource/mcp", { settings: bindings })).status,
  ).toBe(404);
});

test("public discovery permits CORS without weakening API or MCP origin checks", async () => {
  for (const method of ["GET", "HEAD", "OPTIONS"]) {
    const response = await worker.fetch(
      new Request("https://mail.test/.well-known/oauth-protected-resource/mcp", {
        method,
        headers: { Origin: "https://client.test", "Sec-Fetch-Site": "cross-site" },
      }),
      oauth,
      createExecutionContext(),
    );
    expect(response.status).toBe(method === "OPTIONS" ? 204 : 200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    if (method !== "GET") expect(await response.text()).toBe("");
  }
  for (const path of ["/mcp", "/v1/inboxes"]) {
    const response = await worker.fetch(
      new Request(`https://mail.test${path}`, {
        headers: { Origin: "https://client.test", "Cf-Access-Jwt-Assertion": await jwt() },
      }),
      oauth,
      createExecutionContext(),
    );
    expect(response.status).toBe(403);
  }
});

test("configuration fails closed without falling back to token-only authentication", async () => {
  const cases: Env[] = [
    { ...oauth, AGENTPOST_CURSOR_KEY: undefined },
    { ...oauth, AGENTPOST_ACCESS_TEAM_DOMAIN: "https://test-oauth.cloudflareaccess.com.evil.test" },
    { ...oauth, AGENTPOST_ACCESS_TEAM_DOMAIN: "http://test-oauth.cloudflareaccess.com" },
    { ...oauth, AGENTPOST_ACCESS_AUD: "" },
    { ...oauth, AGENTPOST_ACCESS_PRINCIPALS: '{"user:alice":"superuser"}' },
    { ...oauth, AGENTPOST_OAUTH_RESOURCE_URL: "https://mail.test/mcp?token=secret" },
    { ...oauth, AGENTPOST_OAUTH_AUTHORIZATION_SERVER: "http://login.test" },
    { ...oauth, AGENTPOST_AUTH_MODE: "both", AGENTPOST_ADMIN_TOKEN: undefined },
  ];
  for (const settings of cases) {
    const response = await api("/v1/inboxes", { token: adminToken, settings });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("secret");
  }
  const badMode = { ...bindings };
  Object.defineProperty(badMode, "AGENTPOST_AUTH_MODE", { value: "typo" });
  expect((await api("/v1/inboxes", { token: adminToken, settings: badMode })).status).toBe(503);
});

test("forged or wrong-context Access assertions are rejected even alongside a valid static token", async () => {
  const both: Env = { ...oauth, AGENTPOST_AUTH_MODE: "both", AGENTPOST_ADMIN_TOKEN: adminToken };
  const now = Math.floor(Date.now() / 1000);
  const assertions = [
    "",
    "not.a.jwt",
    await jwt("alice", {}, wrongKey),
    await jwt("alice", { aud: "b".repeat(64) }),
    await jwt("alice", { iss: "https://other.cloudflareaccess.com" }),
    await jwt("alice", { exp: now - 1 }),
    await jwt("alice", { exp: undefined }),
    await jwt("alice", { nbf: now + 3600 }),
    await jwt("alice", { type: "org" }),
    await new SignJWT({ iss: issuer, aud, sub: "alice", type: "app", iat: now, exp: now + 600 })
      .setProtectedHeader({ alg: "HS256" })
      .sign(new TextEncoder().encode("x".repeat(32))),
  ];
  for (const assertion of assertions) {
    const response = await api("/v1/inboxes", { assertion, token: adminToken, settings: both });
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain(assertion || "synthetic");
  }
  expect((await api("/v1/inboxes", { token: adminToken, settings: both })).status).toBe(200);
  // Token-only deliberately ignores assertion headers; it never grants OAuth access.
  expect((await api("/v1/inboxes", { assertion: await jwt(), settings: bindings })).status).toBe(
    401,
  );
});

test("only verified allowlisted identities receive roles; user claims cannot grant administrator access", async () => {
  const unlisted = await jwt("unlisted", { role: "admin", email: "operator@example.com" });
  expect((await api("/v1/inboxes", { assertion: unlisted })).status).toBe(403);
  expect(
    (await api("/v1/health", { assertion: await jwt("alice", { role: "admin" }) })).status,
  ).toBe(403);
  expect((await api("/v1/health", { assertion: await jwt("operator") })).status).toBe(200);
  const service = await jwt("", { common_name: "machine.access" });
  expect((await api("/v1/inboxes", { method: "POST", body: {}, assertion: service })).status).toBe(
    201,
  );
  expect((await api("/v1/inboxes", { assertion: await jwt("") })).status).toBe(403);
});

test("OAuth agents provision and access only their own inboxes, including through send and event routes", async () => {
  const a = await create();
  const b = await create("bob");
  const alice = await jwt();
  expect(
    (
      await api("/v1/inboxes", {
        method: "POST",
        body: { owner_id: "forged-owner" },
        assertion: alice,
      })
    ).status,
  ).toBe(400);
  const list = await api("/v1/inboxes", { assertion: alice });
  expect(await list.json()).toMatchObject({ items: [{ id: a.id }] });
  for (const suffix of ["", "/messages", "/outbox", "/webhook", "/webhook/deliveries"]) {
    expect((await api(`/v1/inboxes/${a.id}${suffix}`, { assertion: alice })).status).toBe(200);
    expect((await api(`/v1/inboxes/${b.id}${suffix}`, { assertion: alice })).status).toBe(404);
  }
  expect(
    (
      await api(`/v1/inboxes/${a.id}/send`, {
        method: "POST",
        body: { to: ["recipient@example.net"], subject: "Test", text: "Body" },
        assertion: alice,
      })
    ).status,
  ).toBe(202); // Server generates a UUID when the key is omitted.
  const webhook = { url: "https://receiver.example.org/oauth" };
  expect(
    (await api(`/v1/inboxes/${a.id}/webhook`, { method: "PUT", body: webhook, assertion: alice }))
      .status,
  ).toBe(200);
  expect(
    (await api(`/v1/inboxes/${b.id}/webhook`, { method: "PUT", body: webhook, assertion: alice }))
      .status,
  ).toBe(404);
  expect(
    (await api(`/v1/inboxes/${b.id}/webhook`, { method: "DELETE", assertion: alice })).status,
  ).toBe(404);
  expect(
    (await api(`/v1/inboxes/${a.id}/webhook`, { method: "DELETE", assertion: await jwt() })).status,
  ).toBe(200);
  const queued = await api(`/v1/inboxes/${a.id}/send`, {
    method: "POST",
    body: { to: ["recipient@example.net"], subject: "OAuth send", text: "Body" },
    assertion: alice,
    key: "oauth-owned-send",
  });
  expect(queued.status).toBe(202);
  expect(await queued.json()).toMatchObject({ payload: { from: a.address }, status: "pending" });
  for (const suffix of ["send", "messages/foreign/reply", "outbox/foreign/resolve"]) {
    expect(
      (
        await api(`/v1/inboxes/${b.id}/${suffix}`, {
          method: "POST",
          body: { to: ["recipient@example.net"], subject: "Forbidden", text: "Body" },
          assertion: alice,
          key: "oauth-foreign-send",
        })
      ).status,
    ).toBe(404);
  }
  expect((await api(`/v1/inboxes/${b.id}/messages/foreign/raw`, { assertion: alice })).status).toBe(
    404,
  );
  expect((await poll(alice, b.id)).status).toBe(403);
  expect(
    (
      await api("/v1/events/poll", {
        method: "POST",
        body: { name: "message.received" },
        assertion: alice,
      })
    ).status,
  ).toBe(403);
  expect(
    (await api(`/v1/inboxes/${a.id}/token`, { method: "POST", assertion: alice })).status,
  ).toBe(403);
  expect(
    (await api(`/v1/inboxes/${a.id}/token`, { method: "POST", assertion: await jwt("operator") }))
      .status,
  ).toBe(409);
  const all = await api("/v1/inboxes", { assertion: await jwt("operator") });
  expect((await all.json<{ items: unknown[] }>()).items).toHaveLength(2);
  const disabled = await api(`/v1/inboxes/${a.id}`, {
    method: "PATCH",
    body: { active: false },
    assertion: await jwt("operator"),
  });
  expect(disabled.status).toBe(200);
  expect((await api(`/v1/inboxes/${a.id}/messages`, { assertion: alice })).status).toBe(404);
  expect((await poll(alice, a.id)).status).toBe(403);
});

test("both mode retains legacy inbox tokens without assigning unowned inboxes to OAuth users", async () => {
  const both: Env = { ...oauth, AGENTPOST_AUTH_MODE: "both", AGENTPOST_ADMIN_TOKEN: adminToken };
  const legacy = await api("/v1/inboxes", {
    method: "POST",
    body: {},
    token: adminToken,
    settings: both,
  });
  const box = await legacy.json<{ id: string; token: string }>();
  expect((await api(`/v1/inboxes/${box.id}`, { token: box.token, settings: both })).status).toBe(
    200,
  );
  expect(
    (await api(`/v1/inboxes/${box.id}`, { assertion: await jwt(), settings: both })).status,
  ).toBe(404);
  const owned = await create("alice", both);
  expect(owned.token).toBeUndefined();
  const rotation = await api(`/v1/inboxes/${owned.id}/token`, {
    method: "POST",
    assertion: await jwt("operator"),
    settings: both,
  });
  expect(rotation.status).toBe(200);
  const delegated = await rotation.json<{ token: string }>();
  expect(
    (await api(`/v1/inboxes/${owned.id}`, { token: delegated.token, settings: both })).status,
  ).toBe(200);
});

test("refreshed JWTs resume the same inbox cursor while role changes invalidate it", async () => {
  const box = await create();
  const before = eventPollPageSchema.parse(await (await poll(await jwt(), box.id)).json());
  await bindings.DB.prepare(
    "INSERT INTO messages (id, inbox_id, raw_key, envelope_from, envelope_to, created_at, status) VALUES (?, ?, ?, ?, ?, ?, 'pending')",
  )
    .bind("a".repeat(64), box.id, "raw/test.eml", "sender@example.net", box.address, Date.now())
    .run();
  await bindings.DB.prepare("UPDATE messages SET status = 'ready' WHERE id = ?")
    .bind("a".repeat(64))
    .run();
  const resumed = await poll(await jwt("alice", { jti: "refreshed-token" }), box.id, before.cursor);
  expect(resumed.status).toBe(200);
  expect(eventPollPageSchema.parse(await resumed.json()).events).toHaveLength(1);
  const changed: Env = {
    ...oauth,
    AGENTPOST_ACCESS_PRINCIPALS: JSON.stringify({ "user:alice": "admin" }),
  };
  expect((await poll(await jwt(), box.id, before.cursor, changed)).status).toBe(400);
  const revoked: Env = { ...oauth, AGENTPOST_ACCESS_PRINCIPALS: "{}" };
  expect((await poll(await jwt(), box.id, before.cursor, revoked)).status).toBe(403);
});

test("JWKS unavailability is a generic 503 rather than token fallback", async () => {
  const settings: Env = {
    ...oauth,
    AGENTPOST_ACCESS_TEAM_DOMAIN: "https://offline-oauth.cloudflareaccess.com",
  };
  const assertion = await jwt("alice", { iss: settings.AGENTPOST_ACCESS_TEAM_DOMAIN });
  const response = await api("/v1/inboxes", { assertion, settings });
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("synthetic");
  expect(keyRequests).toEqual(["https://offline-oauth.cloudflareaccess.com/cdn-cgi/access/certs"]);
});

test("JWKS redirects fail closed without following an untrusted location on workerd", async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const redirectedIssuer = `https://redirect-${status}.cloudflareaccess.com`;
    const requests: string[] = [];
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      new Request(input, init);
      requests.push(String(input));
      expect(init?.redirect).toBe("manual");
      return new Response("", {
        status,
        headers: { Location: "https://untrusted.invalid/private-keys" },
      });
    });
    const response = await api("/v1/inboxes", {
      assertion: await jwt("alice", { iss: redirectedIssuer }),
      settings: { ...oauth, AGENTPOST_ACCESS_TEAM_DOMAIN: redirectedIssuer },
    });
    expect(response.status).toBe(503);
    expect(requests).toEqual([`${redirectedIssuer}/cdn-cgi/access/certs`]);
  }
});

test("a signed assertion is revalidated on each MCP event poll and expiration terminates the stream", async () => {
  const box = await create();
  const assertion = await jwt("alice", { exp: Math.floor(Date.now() / 1000) + 2 });
  const client = new Client(
    { name: "expiry-test", version: "1" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL("https://mail.test/mcp"), {
      requestInit: { headers: { "Cf-Access-Jwt-Assertion": assertion } },
      fetch: (url, init) => worker.fetch(new Request(url, init), oauth, createExecutionContext()),
    }),
  );
  let activated!: () => void;
  const active = new Promise<void>((resolve) => {
    activated = resolve;
  });
  let ended!: () => void;
  const terminated = new Promise<void>((resolve) => {
    ended = resolve;
  });
  const schema = z.object({}).passthrough();
  client.setNotificationHandler("notifications/events/active", { params: schema }, activated);
  client.setNotificationHandler("notifications/events/terminated", { params: schema }, ended);
  const controller = new AbortController();
  const stream = client.request(
    {
      method: "events/stream",
      params: { name: "message.received", arguments: { inbox_id: box.id } },
    },
    z.object({ _meta: z.object({}) }),
    { signal: controller.signal, timeout: 12_000 },
  );
  void stream.catch(() => {});
  try {
    await active;
    await terminated;
    await stream;
  } finally {
    controller.abort();
    await client.close();
  }
}, 15_000);

test("the real MCP OAuth client discovers the AS and completes a PKCE exchange before connecting", async () => {
  let saved: StoredOAuthTokens | undefined;
  let verifier = "";
  let redirect: URL | undefined;
  let exchanged = false;
  const assertion = await jwt();
  const provider: OAuthClientProvider = {
    redirectUrl: "http://127.0.0.1:9876/callback",
    clientMetadata: {
      redirect_uris: ["http://127.0.0.1:9876/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    clientInformation: () => ({ client_id: "registered-test-client" }),
    tokens: () => saved,
    saveTokens: (tokens) => {
      saved = tokens;
    },
    state: () => "synthetic-state",
    redirectToAuthorization: (url) => {
      redirect = url;
    },
    saveCodeVerifier: (value) => {
      verifier = value;
    },
    codeVerifier: () => verifier,
  };
  const requests: string[] = [];
  const request = async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    requests.push(req.url);
    if (url.origin === "https://mail.test") {
      const headers = new Headers(req.headers);
      headers.delete("Cf-Access-Jwt-Assertion");
      // Simulate Access's opaque-token resolution, not a second product verifier.
      if (req.headers.get("Authorization") === "Bearer oauth:synthetic-access-token")
        headers.set("Cf-Access-Jwt-Assertion", assertion);
      return worker.fetch(new Request(req, { headers }), oauth, createExecutionContext());
    }
    if (req.url === "https://login.test/.well-known/oauth-authorization-server")
      return Response.json({
        issuer: "https://login.test",
        authorization_endpoint: "https://login.test/authorize",
        token_endpoint: "https://login.test/token",
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        authorization_response_iss_parameter_supported: true,
      });
    if (req.url === "https://login.test/token") {
      const params = new URLSearchParams(await req.text());
      expect(params.get("grant_type")).toBe("authorization_code");
      expect(params.get("code")).toBe("synthetic-authorized-code");
      expect(params.get("resource")).toBe("https://mail.test/mcp");
      expect(params.get("code_verifier")).toBe(verifier);
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
      const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/, "");
      expect(redirect?.searchParams.get("code_challenge")).toBe(challenge);
      exchanged = true;
      return Response.json({
        access_token: "oauth:synthetic-access-token",
        token_type: "Bearer",
        expires_in: 600,
        refresh_token: "synthetic-refresh-token",
      });
    }
    return new Response(null, { status: 404 });
  };
  const first = new Client(
    { name: "oauth-discovery-test", version: "1" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  const transport = new StreamableHTTPClientTransport(new URL("https://mail.test/mcp"), {
    authProvider: provider,
    fetch: request,
  });
  const second = new Client(
    { name: "oauth-authorized-test", version: "1" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  try {
    await expect(first.connect(transport)).rejects.toThrow();
    const authorization = new URL(z.string().parse(redirect?.href));
    expect(authorization.origin).toBe("https://login.test");
    expect(authorization.searchParams.get("state")).toBe("synthetic-state");
    expect(authorization.searchParams.get("resource")).toBe("https://mail.test/mcp");
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    await transport.finishAuth(
      new URLSearchParams({
        code: "synthetic-authorized-code",
        iss: "https://login.test",
        state: "synthetic-state",
      }),
    );
    expect(exchanged).toBe(true);
    await second.connect(
      new StreamableHTTPClientTransport(new URL("https://mail.test/mcp"), {
        authProvider: provider,
        fetch: request,
      }),
    );
    const result = await second.callTool({
      name: "create_inbox",
      arguments: { local_part: "oauth-research" },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ address: "oauth-research@example.com" });
    expect(result.structuredContent).not.toHaveProperty("token");
    expect(requests).toContain("https://mail.test/.well-known/oauth-protected-resource/mcp");
    const foreign = await create("bob");
    const denied = await second.callTool({
      name: "get_inbox",
      arguments: { inbox_id: foreign.id },
    });
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied)).not.toContain(foreign.address);
    expect(requests).toContain("https://login.test/token");
  } finally {
    await first.close();
    await second.close();
  }
});
