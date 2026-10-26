# Authentication and authorization

[English](authentication.md) | [日本語](authentication.ja.md)

Agentpost supports native remote MCP OAuth through Cloudflare Access Managed OAuth, preconfigured Bearer tokens, or both. Authentication establishes an identity; application roles and inbox ownership determine what that identity can do.

## Choose a mode

Set `AGENTPOST_AUTH_MODE` in Worker vars:

| Mode              | Accepted credentials                   | Required configuration                                                      |
| ----------------- | -------------------------------------- | --------------------------------------------------------------------------- |
| `token` (default) | Existing admin/inbox Bearer tokens     | `AGENTPOST_ADMIN_TOKEN`; optional independent cursor key                    |
| `oauth`           | Verified Access application assertions | Access settings below and `AGENTPOST_CURSOR_KEY`; no admin API token needed |
| `both`            | Either mechanism                       | Both sets of configuration                                                  |

An unknown mode or incomplete enabled configuration fails closed with 503. An explicit invalid Access assertion never falls back to a Bearer token. Token-only mode does not trust Access headers. All enabled modes preserve the shared HTTPS, rate-limit, and origin checks.

## Cloudflare configuration

Cloudflare is the authorization server. Agentpost is the protected resource server; it does not implement login pages, code issuance, refresh-token storage, or its own OAuth authorization server.

1. Deploy the Worker and apply all D1 migrations, including `0005_oauth_ownership.sql`.
2. Configure an Access application for the canonical hostname in the same Cloudflare/Zero Trust account. Restrict its policies to the intended identities and configure your identity provider's MFA requirements.
3. Enable **Managed OAuth**. Allow only the redirect URIs required by your MCP clients. Configure loopback redirects only when a desktop client needs them. Prefer short access-token lifetimes (Cloudflare suggests 5–15 minutes), and choose a grant/session lifetime for your use case.
4. From the application's authorization-server metadata at `https://YOUR_HOST/.well-known/oauth-authorization-server`, copy the exact `issuer`. This can differ from the Access JWT issuer; do not substitute the team domain.
5. Configure the Worker vars below and register an independent cursor secret with `mise exec -- bun run wrangler secret put AGENTPOST_CURSOR_KEY`. Generate its value with `openssl rand -hex 32` and keep it out of Git/chat.

Example vars (replace every identity and URL):

```json
{
  "AGENTPOST_AUTH_MODE": "oauth",
  "AGENTPOST_ACCESS_TEAM_DOMAIN": "https://YOUR_TEAM.cloudflareaccess.com",
  "AGENTPOST_ACCESS_AUD": "YOUR_64_CHARACTER_APPLICATION_AUD_TAG",
  "AGENTPOST_OAUTH_RESOURCE_URL": "https://mail.example.com/mcp",
  "AGENTPOST_OAUTH_AUTHORIZATION_SERVER": "https://EXACT_ISSUER_FROM_ACCESS_METADATA",
  "AGENTPOST_ACCESS_PRINCIPALS": "{\"user:YOUR_OPERATOR_SUB\":\"admin\",\"user:YOUR_AGENT_USER_SUB\":\"agent\"}"
}
```

| Setting                                | Meaning                                                                                           |
| -------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `AGENTPOST_ACCESS_TEAM_DOMAIN`         | HTTPS origin of the trusted `*.cloudflareaccess.com` team; also the JWT issuer and JWKS authority |
| `AGENTPOST_ACCESS_AUD`                 | Exact application AUD tag (64 lowercase hexadecimal characters)                                   |
| `AGENTPOST_OAUTH_RESOURCE_URL`         | Canonical HTTPS MCP URL ending in `/mcp`, without credentials/query/fragment                      |
| `AGENTPOST_OAUTH_AUTHORIZATION_SERVER` | Exact OAuth AS issuer from Access metadata, including any path/trailing slash                     |
| `AGENTPOST_ACCESS_PRINCIPALS`          | JSON identity-to-role allowlist; unknown identities have no application access                    |
| `AGENTPOST_CURSOR_KEY`                 | Independent Worker Secret, 32–256 random letters/digits/`_`/`-`; required for OAuth/both          |

Use `user:<sub>` from a trusted Access session's application identity, or `service:<common_name>` for an Access service-token Client ID. Obtain identifiers privately from your trusted Cloudflare session/identity records. Roles are `admin` and `agent`; there is no email-header-based admin bootstrap. A user admitted by Access but missing from this allowlist receives 403. Service Auth policies and service-token headers are configured at Access, not stored as agentpost admin tokens.

Official references: [Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/), [application JWT](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/), [JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/).

## MCP client connection

Register `https://YOUR_HOST/mcp` as a remote Streamable HTTP server in a client supporting MCP OAuth. Let the client perform discovery, browser authorization, PKCE code exchange, and secure refresh-token storage. Preconfigured client registration or an Access-supported registration flow is required. Do not paste an admin token into an OAuth connection.

The Worker publishes RFC 9728 metadata at `/.well-known/oauth-protected-resource/mcp` and the root alias. A 401 advertises its canonical URL through `WWW-Authenticate`. The AS handles its own metadata/endpoints at Cloudflare. Public protected-resource metadata supports GET/HEAD/OPTIONS and permissive CORS; authenticated API/MCP requests retain the existing same-origin browser policy. Use a native or backend MCP client for cross-origin applications.

Managed OAuth access tokens are opaque: Cloudflare resolves them and forwards `Cf-Access-Jwt-Assertion`. The Worker verifies that assertion with RS256, the configured JWKS, issuer, application audience, required claims, expiry/not-before, and `type: app`. It never accepts email/role headers as proof of identity. JWKS requests are limited to the configured team endpoint, reject redirects, time out, and bound response size. Verification outages return 503; invalid credentials return 401.

The CLI and stdio MCP retain their environment-token workflow. This change adds OAuth to remote HTTP MCP; it does not add a CLI browser-login/refresh-token manager. For an agent without a human login, use a scoped inbox token in token/both mode, or configure Access Service Auth and an explicit service identity grant. Standard MCP OAuth applies to HTTP, not stdio.

## Authorization

| Identity                    | Allowed operations                                                                                                                                   |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Admin token / OAuth `admin` | All inboxes, provisioning, inbox metadata editing, token management when enabled, disabling/enabling, health, domain diagnostics, and reconciliation |
| Inbox token                 | Read/send/reply/events for that active inbox; cannot provision/list all inboxes or administer                                                        |
| OAuth `agent`               | Provision owned inboxes, list own inbox metadata, edit metadata/read/send/reply on active owned inboxes; events require an explicit owned `inbox_id` |

[Inbox metadata](inbox-metadata.md) includes label, free-form notes, and site URLs. Authorized inbox readers can see it; editing requires admin or OAuth ownership and cannot change identity, activity, or credentials.

OAuth agent grants do not permit disabling/enabling, token rotation, health, or reconciliation. Inbox creation records a stable, issuer-bound owner hash in D1. JWT refreshes preserve ownership and event cursor scope. Changing a principal's role invalidates its existing cursors. All MCP tools and internal event polling go through the same API authorization checks; inbound SMTP, queues, and Cron are not HTTP OAuth clients.

OAuth-authenticated provisioning never returns an inbox token, including in both mode: an OAuth agent cannot mint a persistent token to outlive its grant. Token-authenticated provisioning retains its token response. OAuth-only mode disables token rotation. In both mode an administrator can explicitly rotate/issue an inbox token as a delegation credential. Such a token remains independent of OAuth grant revocation until it is rotated or the inbox is disabled. Existing random/named inboxes keep `owner_id = NULL`; they remain accessible to their inbox token (when enabled) and admins, and are never automatically assigned to a newly logged-in user.

Ownership is per Access identity, not per MCP client or task. Multiple agents logged in as the same user share that user's owned inboxes. Use distinct identities or separate inbox tokens when tasks need stronger separation. Access/OAuth scopes are not invented to substitute for application roles.

Inbox-authorized identities can also read, replace, or remove that inbox's [receive webhook](webhooks.md) and inspect its delivery states. Destinations must satisfy the operator's trusted-origin policy. A webhook is persistent inbox configuration: rotating a token or revoking an OAuth grant does not remove it. Remove its webhook or disable the inbox when revoking trust in a former owner or receiver.

## Both-mode ingress and revocation

An Access login barrier also applies to requests carrying an agentpost static token; selecting `both` in the Worker does not bypass Access at the edge. A straightforward deployment uses an Access-protected OAuth hostname and a separate token hostname routed to the same Worker. Secure both with HTTPS and their intended policies. Missing signed assertions on an OAuth-only Worker never authorize a direct `workers.dev` request.

JWTs are validated on every internal event poll, normally every five seconds. Expiry or a missing current grant terminates the stream. Expiry/role checks are not remote introspection: already-issued assertions can remain valid until expiry, and an old Worker stream can retain its deployment's role configuration. Set appropriate Access session lifetimes and reconnect/drain old streams during grant-policy deployments. The MCP client resumes with a refreshed token and its saved cursor; do not silently discard rejected checkpoints.

Creating/changing `AGENTPOST_CURSOR_KEY` invalidates existing encrypted cursors, including token subscriptions. Plan migration, reconcile message/outbox state, and deliberately start new checkpoints. Token-only deployments without this secret retain the previous admin-secret-derived key for compatibility.

Owner hashes, token hashes, and outbound idempotency state live in D1; retained MIME cannot reconstruct identity ownership. Follow [backup/recovery](operations.md) before restoring permissions or data.

## Verification and production limits

`test/oauth.test.ts` verifies real RS256 signatures/JWKS, tampering/audience/issuer/expiry/type rejection, fail-closed settings, ownership isolation, token compatibility, cursor refresh, stream expiry, and the actual MCP SDK's discovery/PKCE code exchange. The authorization server and Cloudflare opaque-token resolution are local test doubles. No real Cloudflare Access application, identity provider login, or production MCP host connection is claimed verified. Complete those live checks before enabling OAuth in production.

## Forwarding administration

Global and per-inbox forwarding settings, effective destinations, delivery histories and reconciliation are admin-only. Inbox tokens and OAuth `agent` identities cannot access these endpoints or redirect future incoming mail. Destinations require an independent operator allowlist and native Cloudflare verification. [Forwarding](forwarding.md) changes never authorize a send or disclose mail merely from instructions in an email.
