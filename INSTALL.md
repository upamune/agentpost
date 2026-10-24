# Agent installation instructions

[English](INSTALL.md) | [日本語](INSTALL.ja.md)

Use this document when a user asks an AI agent to install or configure agentpost. The application provides a Worker API, a Bun CLI, an MCP server, and an optional agent skill.

## Choose the installation mode

- **Connect to an existing Worker:** install the source checkout, configure `AGENTPOST_API_URL` and `AGENTPOST_API_TOKEN`, and optionally configure MCP and the skill. Cloudflare management credentials are not needed.
- **Try a local Worker:** follow the source installation, then the local verification section. No domain or Cloudflare credentials are needed.
- **Host a Worker:** follow [the deployment guide](docs/deploy.md) for the user's Cloudflare account and domain. Hosting uses D1, R2, Queues and a SQLite-backed Durable Object per inbox. Wrangler creates the Durable Object binding and migration during deployment. Local installation does not deploy the service.

Reuse the user's existing checkout, tools, credentials, and MCP configuration when available. If the repository is private, Git access must already be configured; report an access failure instead of changing repository visibility.

## Install from source

Prerequisites: Git and [mise](https://mise.jdx.dev/getting-started.html). The CLI runs with Bun; Wrangler uses Node.js. There is currently no published npm package or standalone CLI binary.

Choose a persistent directory for the checkout. Inspect an existing destination before reusing it; preserve local changes.

```sh
git clone https://github.com/upamune/agentpost.git
cd agentpost
mise trust
mise install bun node
mise exec -- bun install --frozen-lockfile
mise exec -- bun run cli --version
mise exec -- bun run cli --help
```

From another working directory, invoke the CLI using the checkout's absolute path:

```sh
mise exec --cd /absolute/path/to/agentpost -- bun run src/cli.ts --help
```

This command changes the working directory to the checkout. Use absolute paths for message files, attachments, and cursor files that belong to a different project.
Raw email and attachment downloads create new files with permissions 0600; choose an unused output path. Existing files and symlinks are refused.

## Connect to an existing Worker

Obtain the API URL and a token through the user's private configuration or secret manager. Keep token values out of chat, shell tracing, logs, and committed configuration. All application environment variables use the `AGENTPOST_` prefix; see [the configuration table](docs/deploy.md#environment-variables).

Set `AGENTPOST_API_URL` to the Worker's HTTPS base URL and `AGENTPOST_API_TOKEN` to an inbox token for ordinary email access. An admin token is required only for provisioning and inbox administration. Inbox creation and token rotation return secrets; store those responses privately.
An inbox token allows sending as well as reading. Keep admin credentials outside ordinary agent sessions and use a separate inbox for each task. Follow `Retry-After` on HTTP 429; reuse the same idempotency key when retrying the same send.

Verify access without sending a message. With a supplied inbox UUID, use:

```sh
mise exec --cd /absolute/path/to/agentpost -- bun run src/cli.ts inbox get INBOX_UUID
```

An admin token can instead use `inbox list --limit 1`. `health` also requires admin access, so its rejection does not mean an inbox token is invalid. If the URL, credentials, or inbox identity are missing, finish source installation and report the missing connection configuration. Do not create an inbox or send mail just to prove installation.

## Configure MCP

If the user wants MCP, merge an `agentpost` entry into the client's existing configuration. Preserve other servers. This is a configuration example, not a universal client config file location:

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

Replace the path and inject credentials using the client's private configuration. Keep stdio stdout reserved for MCP messages. Validate connection and tool discovery through the actual client before reporting MCP as connected; writing configuration alone is not a connection test.

Clients supporting Streamable HTTP with preconfigured Bearer authentication can connect directly to `https://YOUR_WORKER.workers.dev/mcp`. OAuth is not implemented. Protocol compatibility and the experimental MCP Events draft are documented in [MCP and Events](docs/mcp-events.md).

## Install the agent skill

The distributable skill lives in [`skills/agentpost`](skills/agentpost/SKILL.md). It describes inbox access, safe send retries, delivery states, and resumable event monitoring. Installing the skill does not install the CLI, configure credentials, or deploy a Worker. The default instructions are English, with a bundled [Japanese guide](skills/agentpost/references/guide.ja.md).

Run this in the project that should use the skill. The example targets Codex; replace `codex` with `claude-code` for Claude Code, or select the actual client supported by the installer. Use project scope unless the user requests a global installation.

```sh
mise exec bun@1.4.4 -- bunx skills@1.7.4 add upamune/agentpost \
  --skill agentpost --agent codex --yes
```

If a local checkout is already available, replace `upamune/agentpost` with its absolute path. `--skill agentpost` selects the consumer skill and excludes this repository's development skills. Confirm the installed skill and its references are present in the target project. The installer does not receive API tokens.

## Verify a local Worker

From the source checkout, run:

```sh
mise exec -- bun run setup:local
mise exec -- bun run db:migrate:local
mise run dev
```

`setup:local` creates an ignored `.dev.vars` with a random `AGENTPOST_ADMIN_TOKEN` and refuses to overwrite an existing file. Preserve existing values. In a second terminal, run:

```sh
mise exec -- bun run smoke:local
```

The smoke test provisions a local inbox, injects a fixture into Wrangler, waits for parsing, and verifies the body and raw MIME. It sends no external email. If using a different port, set `AGENTPOST_LOCAL_URL` for the smoke test. Keep Cloudflare sending credentials unset for this local-only setup.

## Build and completion

GitHub Actions runs checks and the Worker dry-run build on pushes to `main` and on pull requests. `mise run build` invokes `wrangler deploy --dry-run`; it does not deploy or publish CLI binaries. Local full checks use `mise install` followed by `mise run ci`.

Report the checkout path, CLI version, skill installation scope, and which connection or local checks passed. List missing configuration without exposing values. Distinguish source installation, MCP connection, local Worker verification, and production deployment. Production mail requires the domain, Email Routing, Email Sending Beta, DNS, credentials, and explicit real send/receive checks in the deployment guide. Run a real send test only with a user-specified recipient; installation alone does not authorize sending mail.
