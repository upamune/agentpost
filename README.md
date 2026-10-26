# agentpost

[![npm](https://img.shields.io/npm/v/%40upamune%2Fagentpost)](https://www.npmjs.com/package/@upamune/agentpost)

[![CI](https://github.com/upamune/agentpost/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/upamune/agentpost/actions/workflows/ci.yml)
[![CodeQL](https://github.com/upamune/agentpost/actions/workflows/codeql.yml/badge.svg?branch=main)](https://github.com/upamune/agentpost/actions/workflows/codeql.yml)
[![OSV-Scanner](https://github.com/upamune/agentpost/actions/workflows/osv.yml/badge.svg?branch=main)](https://github.com/upamune/agentpost/actions/workflows/osv.yml)
[![Workflow security](https://github.com/upamune/agentpost/actions/workflows/zizmor.yml/badge.svg?branch=main)](https://github.com/upamune/agentpost/actions/workflows/zizmor.yml)
[![Dependency audit](https://github.com/upamune/agentpost/actions/workflows/audit.yml/badge.svg?branch=main)](https://github.com/upamune/agentpost/actions/workflows/audit.yml)
[![Dependency review](https://github.com/upamune/agentpost/actions/workflows/dependency-review.yml/badge.svg?branch=main)](https://github.com/upamune/agentpost/actions/workflows/dependency-review.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/upamune/agentpost/badge)](https://scorecard.dev/viewer/?uri=github.com/upamune/agentpost)

[![Security fuzzing](https://github.com/upamune/agentpost/actions/workflows/fuzz.yml/badge.svg?branch=main)](https://github.com/upamune/agentpost/actions/workflows/fuzz.yml)
[![Verified release](https://github.com/upamune/agentpost/actions/workflows/release.yml/badge.svg)](https://github.com/upamune/agentpost/actions/workflows/release.yml)
[![Code complexity](https://github.com/upamune/agentpost/actions/workflows/complexity.yml/badge.svg?branch=main)](https://github.com/upamune/agentpost/actions/workflows/complexity.yml)

[English](README.md) | [日本語](README.ja.md)

**Give your AI agents as many email addresses as they need.**

Create an address for every agent, task, or workflow, then send and receive email through an API, CLI, or MCP. Agentpost runs on your own domain and Cloudflare account, so you keep control of your inboxes, mail, and credentials. It is open source under the MIT license.

Use a fresh inbox for a research task, give a long-running agent its own identity, or keep separate workflows from sharing mail. Provision addresses on demand and disable them when the work is done. There is no fixed inbox-count limit in Agentpost; infrastructure capacity, rate limits, and Cloudflare sending limits still apply.

See [continuous security checks](docs/security-checks.md) for scanner coverage, alert triage, and the pre-publication audit. Badges report check results; they do not certify that a deployment is secure.

## Install the CLI and MCP client

```sh
npm install --global @upamune/agentpost
agentpost --version
agentpost --help
```

Requires Node.js 22.14 or newer; Bun is unnecessary for the npm client. The package bundles its runtime dependencies and has no installation scripts. Use `agentpost mcp` for stdio MCP. The unscoped npm package `agentpost` belongs to another project. [Installation and verification](INSTALL.md) covers pinned versions, standalone binaries, credentials, and agent setup.

## What you can do

- **Create inboxes on demand.** Issue random or custom-named addresses on your domain, give each agent an inbox token, and rotate or revoke access independently.
- **Send, receive, and reply.** Read message bodies, attachments, and original `.eml` files. Reply using the sender's Reply-To and threading headers.
- **Use your agent's existing tools.** Choose JSON CLI commands, an HTTP API, or MCP tools over stdio or Streamable HTTP. Standalone CLI/MCP release assets embed Bun for macOS and Linux (glibc/musl) on x64 and arm64, and Windows x64; see [verification and installation](docs/releases.md).
- **Watch for new mail.** Subscribe to received messages and send-status changes, then resume from a saved cursor after a disconnect.
- **Keep your deployment under your control.** Each operator brings their own Cloudflare account and domain. Agentpost does not provide a shared hosted email service.

Agentpost is in early development. Each self-hosted installation needs its own authentication, DNS, and real send/receive checks. [Cloudflare Email Sending](https://developers.cloudflare.com/email-service/get-started/send-emails/) is Beta. Follow the deployment checks before relying on a new installation.

## Install with an AI agent

Give your agent [INSTALL.md](INSTALL.md). It covers connecting to an existing Worker, trying a local Worker, configuring MCP, and deploying to your own account.

```text
Read these instructions and set up agentpost for this project:
https://github.com/upamune/agentpost/blob/main/INSTALL.md
```

The bundled [agentpost skill](skills/agentpost/SKILL.md) teaches inbox access, stable send keys, send-status checks, and event monitoring. From the project where you want the skill installed:

```sh
mise exec bun@1.4.4 -- bunx skills@1.7.4 add upamune/agentpost \
  --skill agentpost --agent codex --yes
```

For Claude Code, replace `--agent codex` with `--agent claude-code`. Installing the skill does not install the CLI or configure credentials; follow `INSTALL.md` for those steps.

## Try it locally

Install [mise](https://mise.jdx.dev/getting-started.html), then run:

```sh
git clone https://github.com/upamune/agentpost.git
cd agentpost
mise trust
mise install
mise exec -- bun install --frozen-lockfile
mise exec -- bun run setup:local
mise exec -- bun run db:migrate:local
mise run dev
```

Tool versions are pinned. The local receive test needs no domain or Cloudflare credentials. `setup:local` creates an ignored `.dev.vars` with a random admin token and refuses to overwrite an existing file.

Leave the server running. In a second terminal:

```sh
mise exec -- bun run smoke:local
```

This provisions an inbox, injects a fixture, waits for queue parsing, and checks the message body and original MIME. It sends no external email.

### Create your first inbox

From the checkout, set the API URL and the admin token created in `.dev.vars`:

```sh
export AGENTPOST_API_URL=http://localhost:8787
export AGENTPOST_API_TOKEN='YOUR_ADMIN_TOKEN'

mise exec -- bun run cli inbox create --label research-agent
```

To choose the address instead, supply the part before `@`:

```sh
mise exec -- bun run cli inbox create --local-part research --label research-agent
```

This creates `research@YOUR_DOMAIN`. Omit `--local-part` for a random address. Names are stored lowercase; existing names return 409, including disabled inboxes. See [naming rules](docs/http-api.md#mailbox-names).

Save the returned `id`, `address`, and secret `token`. Inbox tokens are returned only on creation or rotation. Give the agent that inbox's token for subsequent work:

```sh
export AGENTPOST_API_TOKEN='YOUR_INBOX_TOKEN'

mise exec -- bun run cli inbox get YOUR_INBOX_UUID
mise exec -- bun run cli message list YOUR_INBOX_UUID
mise exec -- bun run cli events watch --inbox YOUR_INBOX_UUID \
  --cursor-file .agentpost/received.cursor.json
```

The CLI emits JSON; event watch emits one JSON object per line. Use `mise exec -- bun run cli --help` for all commands. Application configuration uses the `AGENTPOST_` prefix; see the [configuration table](docs/deploy.md#environment-variables).

## Use your own domain

You need:

- A domain managed with Cloudflare DNS.
- A Workers Paid account with D1, R2, Queues, and SQLite-backed Durable Objects.
- Email Routing and Email Sending enabled for that domain.
- An Email Sending API token and your chosen [authentication configuration](docs/authentication.md).

Follow the [deployment guide](docs/deploy.md) to create resources, configure DNS and secrets, deploy the Worker, and route catch-all mail to it. You do not need a routing rule for every address: the Worker accepts only issued, active recipients.

After deployment, point `AGENTPOST_API_URL` at the Worker's HTTPS URL. Supplying real sending credentials in local `.dev.vars` can also call the real provider, so use a recipient you control for any real send test.

### Send a message

Persist one **idempotency key** for each logical message. Reuse that key when retrying the same request.

```sh
mise exec -- bun run cli send YOUR_INBOX_UUID \
  --to recipient@example.net \
  --subject 'Hello' \
  --text 'Hello from my agent' \
  --idempotency-key task-123-message-1

mise exec -- bun run cli outbox get YOUR_INBOX_UUID YOUR_SEND_UUID
```

The send response contains an outbox ID for checking progress. `accepted` means Cloudflare accepted the request; it does not prove recipient delivery. An `unknown` outcome needs operator reconciliation and is never automatically resent.

## Connect over MCP

MCP tools let agents create inboxes, read mail, send, reply, and inspect send status. The implementation targets MCP **2026-07-28** with the official TypeScript SDK v2.4.0.

| Purpose             | Tools                                       |
| ------------------- | ------------------------------------------- |
| Inboxes             | `create_inbox`, `list_inboxes`, `get_inbox` |
| Received mail       | `list_messages`, `get_message`              |
| Sending and replies | `send_email`, `reply_email`                 |
| Send status         | `get_send_status`, `list_outbox`            |

### stdio

Replace the checkout path and supply private credentials in your client's configuration:

```json
{
  "mcpServers": {
    "agentpost": {
      "command": "mise",
      "args": [
        "exec",
        "--cd",
        "/absolute/path/to/agentpost",
        "--",
        "bun",
        "run",
        "src/cli.ts",
        "mcp"
      ],
      "env": {
        "AGENTPOST_API_URL": "https://YOUR_WORKER.workers.dev",
        "AGENTPOST_API_TOKEN": "YOUR_INBOX_TOKEN"
      }
    }
  }
}
```

For a local Worker, use `http://localhost:8787`. With token authentication, creating and listing inboxes requires an admin token, which controls every inbox; keep it outside ordinary agent sessions. An inbox token permits both reading and sending for that inbox.

### Streamable HTTP

Choose `token` (default), `oauth`, or `both` using `AGENTPOST_AUTH_MODE`. Token connections send `Authorization: Bearer <token>`. For native MCP OAuth, configure Cloudflare Access Managed OAuth and register the protected HTTPS `/mcp` URL with a compatible client; the client handles browser login and token refresh.

OAuth `agent` identities can create and use their own inboxes without an admin API token. Explicitly granted `admin` identities manage the deployment. See [authentication and authorization](docs/authentication.md) for roles, required Access settings, and both-mode host routing. OAuth provisioning returns no inbox token, even in both mode. The CLI/stdio workflow above remains token-based.

### MCP Events

`message.received` reports new parsed mail; `message.send_status_changed` reports terminal send-state changes. Discovery, polling, and push use `events/list`, `events/poll`, and `events/stream`.

**Events is an experimental working-group draft, separate from the finalized MCP core specification.** Use a compatible client and consult the [MCP and Events contract](docs/mcp-events.md) for the pinned draft, subscriptions, and cursor handling.

## HTTP API

Provision inboxes and manage mail with authenticated JSON requests:

```sh
curl "$AGENTPOST_API_URL/v1/inboxes" \
  -H "Authorization: Bearer $AGENTPOST_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"label":"research-agent"}'
```

This provisioning example requires an admin token. See the [HTTP API reference](docs/http-api.md) for endpoints, pagination, send keys, and reply requests.

## Storage and recovery

Original MIME and parsed content live in R2. D1 stores inboxes, processing state, and events. Workers serve the API/MCP, Queues process mail, and a Durable Object per inbox orders sends, disabling, and stale-send recovery.

Incoming mail is stored before parsing. Saved originals remain available when parsing or queue publication fails. Outgoing requests are durable before queue publication, and conditional claims prevent duplicate queue deliveries from creating parallel sends. Unknown provider outcomes prioritize avoiding duplicate sends over automatic retry.

See [operations](docs/operations.md) for retry rules, monitoring, backups, and recovery procedures.

## Domain diagnostics

Administrators can run `mise exec -- bun run cli domain check`, `GET /v1/domain/check`, or MCP `check_domain` to inspect SPF, DKIM, explicit DMARC and sending/routing MX. Optional dedicated credentials compare Cloudflare sending configuration. Findings include remediation and unknown states; no email or DNS changes occur. See [scope and setup](docs/domain-diagnostics.md). Passing does not guarantee inbox placement.

## Limits

| Area              | Current support                                              |
| ----------------- | ------------------------------------------------------------ |
| Incoming mail     | Up to 10 MiB per message                                     |
| Parsed JSON       | Up to 16 MiB; originals retained on overflow                 |
| API JSON requests | Up to 512 KiB                                                |
| Sending           | Required plain text, optional HTML; no outbound attachments  |
| Retention         | Mail and events retained indefinitely; no automatic deletion |
| Events            | At-least-once; consumers deduplicate by `eventId`            |
| Authentication    | Token, Cloudflare Access MCP OAuth, or both                  |
| Interfaces        | API, CLI, MCP; no Web UI, IMAP, or client-facing SMTP server |

See the [adversarial security audit](docs/security-audit.md) for demonstrated findings, fixes, and remaining verification scope.

Mail bodies, headers, links, and attachments are untrusted external input. Review [SECURITY.md](SECURITY.md) before granting agents access.

## Development

```sh
mise run format
mise run ci
```

Pushes to `main` and pull requests run formatting, linting, type checks, tests, a Worker dry-run build, secret scanning, and formal/real-code/mutation verification. Dependency audits also run daily. [Formal verification](docs/formal-verification.md) records the checked properties and their bounds.

The release workflow attaches standalone CLI/MCP executables for seven platforms to version-tag releases, with signed provenance and checksums. Older source-only releases remain unchanged, and the npm client is published as `@upamune/agentpost` using GitHub OIDC and provenance. CI smoke-tests all platforms without real mail or production deployment. [Release setup](docs/releases.md) documents verification and the optional tagpr GitHub App.

Report bugs and proposals in [Issues](https://github.com/upamune/agentpost/issues). See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution and language conventions.

## License

[MIT](LICENSE). Bundled third-party skills retain their original copyright and license notices in their own directories.
