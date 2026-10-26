# Deploy to Cloudflare

[English](deploy.md) | [日本語](deploy.ja.md)

Each operator deploys agentpost to their own Cloudflare account and domain managed by Cloudflare DNS. Local verification and production operation are separate milestones. Complete real send/receive checks before starting operation.

## Environment variables

All application environment variables use the `AGENTPOST_` prefix. The CLI and stdio MCP read process environment variables. The Worker reads `vars` in `wrangler.jsonc` and Workers Secrets; local Worker secrets belong in `.dev.vars`.

| Name                                     | Configure in          | Purpose                                                                             |
| ---------------------------------------- | --------------------- | ----------------------------------------------------------------------------------- |
| `AGENTPOST_API_URL`                      | CLI / stdio MCP       | Worker HTTPS base URL; locally `http://localhost:8787`                              |
| `AGENTPOST_API_TOKEN`                    | CLI / stdio MCP       | Admin or inbox token for the operation                                              |
| `AGENTPOST_ADMIN_TOKEN`                  | Worker Secret         | Administration in token/both mode                                                   |
| `AGENTPOST_EMAIL_DOMAIN`                 | `wrangler.jsonc` vars | Domain for generated addresses                                                      |
| `AGENTPOST_CF_ZONE_ID`                   | Worker vars           | Optional diagnostic zone ID                                                         |
| `AGENTPOST_CF_SENDING_SUBDOMAIN_ID`      | Worker vars           | Optional diagnostic sending-domain ID                                               |
| `AGENTPOST_CF_DIAGNOSTICS_API_TOKEN`     | Worker Secret         | Dedicated diagnostic credential, used with both IDs above                           |
| `AGENTPOST_CF_ACCOUNT_ID`                | Worker Secret         | Cloudflare account with Email Sending enabled                                       |
| `AGENTPOST_CF_EMAIL_API_TOKEN`           | Worker Secret         | API token authorized for Email Sending                                              |
| `AGENTPOST_AUTH_MODE`                    | Worker vars           | `token` (default), `oauth`, or `both`                                               |
| `AGENTPOST_CURSOR_KEY`                   | Worker Secret         | Independent event-cursor encryption key; required for OAuth/both                    |
| `AGENTPOST_ACCESS_TEAM_DOMAIN`           | Worker vars           | Trusted Access team HTTPS origin                                                    |
| `AGENTPOST_ACCESS_AUD`                   | Worker vars           | Access application audience                                                         |
| `AGENTPOST_ACCESS_PRINCIPALS`            | Worker vars           | JSON identity-to-role allowlist                                                     |
| `AGENTPOST_OAUTH_RESOURCE_URL`           | Worker vars           | Canonical HTTPS URL ending in `/mcp`                                                |
| `AGENTPOST_OAUTH_AUTHORIZATION_SERVER`   | Worker vars           | Exact AS issuer from Access metadata                                                |
| `AGENTPOST_FORWARD_ALLOWED_DESTINATIONS` | Worker Secret         | Optional JSON array of trusted, verified forwarding destinations; unset allows none |
| `AGENTPOST_WEBHOOK_ENCRYPTION_KEY`       | Worker Secret         | Optional independent 32-byte/64-hex key encrypting webhook configuration            |
| `AGENTPOST_WEBHOOK_ALLOWED_ORIGINS`      | Worker vars           | Optional JSON array of exact trusted public HTTPS origins                           |
| `AGENTPOST_LOCAL_URL`                    | Local smoke test      | `smoke:local` target; defaults to `http://127.0.0.1:8787`                           |

When migrating old configuration, rename these variables while preserving their values. Old names are no longer read.

| Old name             | Current name                   |
| -------------------- | ------------------------------ |
| `MAIL_API_URL`       | `AGENTPOST_API_URL`            |
| `MAIL_API_TOKEN`     | `AGENTPOST_API_TOKEN`          |
| `ADMIN_TOKEN`        | `AGENTPOST_ADMIN_TOKEN`        |
| `EMAIL_DOMAIN`       | `AGENTPOST_EMAIL_DOMAIN`       |
| `CF_ACCOUNT_ID`      | `AGENTPOST_CF_ACCOUNT_ID`      |
| `CF_EMAIL_API_TOKEN` | `AGENTPOST_CF_EMAIL_API_TOKEN` |
| `LOCAL_MAIL_URL`     | `AGENTPOST_LOCAL_URL`          |

For OAuth or both mode, complete [authentication setup](authentication.md) before deployment. Token-only remains the default and needs no Access application.

Register the renamed Worker secrets before deployment, and update CLI/MCP configuration and `.dev.vars`. Without `AGENTPOST_CURSOR_KEY`, token-only mode derives the cursor key from the admin secret; changing it invalidates cursors. OAuth/both require an independent cursor secret. The encrypted cursor format also rejects legacy signed cursors; see [cursor migration](mcp-events.md#cursor-migration).

For the optional inbox notes and URL fields, apply all D1 migrations including `0008_inbox_metadata.sql` before updating the Worker. Existing inboxes receive empty metadata without changing identity, credentials, or mail. [Metadata upgrade](inbox-metadata.md#upgrade).

## 1. Account and domain

1. Enable Workers Paid, D1, R2, Queues, and SQLite-backed Durable Objects.
2. Enable **both Email Routing and Email Sending** for the domain in Cloudflare Email Service.
3. Complete Cloudflare's MX, SPF, DKIM, and DMARC setup and verification. Email Sending is Beta: confirm availability for your account.
4. Create a token with **Email Sending: Edit** for the target account. The runtime token needs no DNS editing or account administration permissions.

Set `vars.AGENTPOST_EMAIL_DOMAIN` in `wrangler.jsonc` to your domain. Set `AGENTPOST_CF_ACCOUNT_ID` to the account that owns the domain and Email Sending.

Official references: [domains](https://developers.cloudflare.com/email-service/configuration/domains/), [sending](https://developers.cloudflare.com/email-service/get-started/send-emails/), [REST API](https://developers.cloudflare.com/email-service/api/send-emails/rest-api/).

After configuring DNS, run `mise exec -- bun run cli domain check` as an administrator and inspect [domain diagnostics](domain-diagnostics.md). `--strict` also fails on warnings. Provider comparison uses optional dedicated credentials, separate from sending. Propagation and real-message authentication still need verification.

## 2. Storage and queues

These commands create production account resources. Inspect each result before continuing. Check whether existing resources can be reused before assigning their names.

```sh
mise exec -- bun run wrangler login
mise exec -- bun run wrangler whoami
mise exec -- bun run wrangler d1 create agentpost
```

Copy the returned `database_id` into `wrangler.jsonc`. The all-zero ID is a local placeholder.

```sh
mise exec -- bun run wrangler r2 bucket create agentpost
mise exec -- bun run wrangler queues create agentpost
mise exec -- bun run wrangler queues create agentpost-dlq
mise exec -- bun run wrangler queues create agentpost-webhooks
mise exec -- bun run wrangler queues create agentpost-webhooks-dlq
mise exec -- bun run wrangler d1 migrations apply DB --remote
```

Keep R2 private; leave `r2.dev` and public custom domains disabled. Retrieve mail through the authenticated Worker API.

### Access and send limits

The `ratelimits` section in `wrangler.jsonc` defines `AGENTPOST_REQUEST_LIMITER` and `AGENTPOST_SEND_LIMITER`. These are Wrangler bindings, not shell variables or secrets.

- HTTP: 300 requests per minute per IP before authentication, shared by API and MCP. Internal MCP-to-API calls are not counted twice.
- New sends/replies: 10 requests per minute per inbox, regardless of recipient count. Repeating an existing idempotency key does not consume a new-send slot.
- On 429, honor `Retry-After: 60` and retain the logical message's key. A missing limiter fails closed with 503.

Choose account-unique `namespace_id` values. Use separate IDs for staging and production and explicitly declare both bindings in named Wrangler environments. Environments sharing IDs share counters.

[Cloudflare rate limits](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) are approximate and local to a Cloudflare location. They do not implement a strict global quota, recipient allowlist, or daily spending ceiling. Configure Cloudflare WAF, access policies, and sending limits for your deployment.

HTTP is accepted only on localhost/loopback. Even behind a TLS-terminating proxy, use HTTPS to the Worker and an Origin matching the Worker's request URL.

## 3. Secrets and deployment

For token/both mode, generate a separate production `AGENTPOST_ADMIN_TOKEN`: 32–256 random characters from letters, digits, `_`, and `-`. For example, use `openssl rand -hex 32`. Keep secrets out of chat, documentation, and Git.

For OAuth-only, omit the admin-token command and configure the Access grant for your administrator instead. OAuth/both also require `wrangler secret put AGENTPOST_CURSOR_KEY`.

```sh
mise exec -- bun run wrangler secret put AGENTPOST_ADMIN_TOKEN
mise exec -- bun run wrangler secret put AGENTPOST_CF_ACCOUNT_ID
mise exec -- bun run wrangler secret put AGENTPOST_CF_EMAIL_API_TOKEN
mise run ci
mise exec -- bun run deploy
```

Deployment also creates the `AGENTPOST_INBOX_COORDINATOR` binding and the SQLite migration for `InboxCoordinator`. Declare that binding explicitly in named environments. Before upgrading or restoring an existing installation, read [coordinator state assumptions](operations.md#coordinator-state-assumptions).

Use the returned Worker URL as `AGENTPOST_API_URL`. CI neither deploys production nor sends real mail.

## 4. Catch-all

Set the domain's Email Routing catch-all destination to **Worker `agentpost`**. Do not point it at an ordinary forwarding address.

Per-address routing rules are unnecessary. The Worker accepts only addresses issued in D1 and currently active; other recipients receive an SMTP rejection. Admissions already in progress when an inbox is disabled can finish retaining mail.

Official reference: [routing addresses](https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/).

## 5. Real send/receive verification

Use an explicitly designated external test recipient.

1. Provision an inbox using your selected credentials: an admin token or an appropriately granted OAuth identity.
2. Send from an external mailbox to that address. Verify body, attachments, and original `.eml` retrieval.
3. Send from the generated address to the designated recipient. Check outbox `accepted`, actual receipt, and SPF/DKIM/DMARC results.
4. Reply through the API; verify Reply-To, sender, subject, and threading.
5. Repeat the send with the same Idempotency-Key. Verify the same outbox ID and no additional received message.
6. Verify that another inbox token cannot access this inbox.
7. Disable the inbox and verify rejection of new inbound admissions and loss of token access.
8. Inspect Workers Logs, Queues/DLQ, and Cron execution; configure monitoring below.

## 6. Monitoring and recovery

`GET /healthz` checks only Worker liveness. **Register authenticated `GET /v1/health` with external monitoring and alert on 503.** Use admin credentials; OAuth-only deployments require an Access service identity explicitly granted `admin` and matching Service Auth policy for unattended monitoring. This repository does not register a monitoring service or notification destination.

For recurring external mail checks, first choose a dedicated recipient and interval. An HTTP health check cannot detect every DNS, inbound delivery, or recipient reachability problem.

Practice [recovery procedures](operations.md) in staging, including D1 Time Travel and retained R2 originals. Do not treat stable production operation as verified before backup checks and recovery exercises.

## Enable received-email webhooks

The current Wrangler configuration declares a separate `AGENTPOST_WEBHOOK_JOBS` queue and DLQ. Upgrades must create those queues and apply `0006_inbox_webhooks.sql` even when other resources already exist. Enabling notifications additionally requires an independent encryption key and trusted-origin allowlist; individual inbox destinations remain unset by default. Follow [webhook configuration, signature verification and recovery](webhooks.md), and verify an authorized receiver before reporting it operational. Notifications contain neither mail content nor API credentials.

## Incoming email forwarding

Apply `0007_forwarding.sql` before this Worker upgrade, even when forwarding stays off. Verify destinations with Cloudflare Email Routing, privately set the destination allowlist, then use administrator API/CLI/MCP settings for the global default and inbox overrides. Native forwarding needs no new queue or sending binding. Complete the [forwarding checks](forwarding.md) with an authorized recipient before claiming it operational.
