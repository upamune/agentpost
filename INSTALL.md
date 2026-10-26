# Agent installation instructions

[English](INSTALL.md) | [日本語](INSTALL.ja.md)

Use this document when a user asks an AI agent to install or configure agentpost. The application provides a Worker API, an npm/standalone CLI, an MCP server, and an optional agent skill.

## Choose the installation mode

- **Connect remote MCP with OAuth:** use a compatible client and an Access-protected `/mcp` URL. The client performs login and refresh. A source checkout, CLI, and `AGENTPOST_API_TOKEN` are unnecessary unless other workflows need them. See [authentication](docs/authentication.md).

- **Connect to an existing Worker:** install the npm package, a verified standalone executable, or the source checkout, configure `AGENTPOST_API_URL` and `AGENTPOST_API_TOKEN`, and optionally configure MCP and the skill. Cloudflare management credentials are not needed.
- **Try a local Worker:** follow the source installation, then the local verification section. No domain or Cloudflare credentials are needed.
- **Host a Worker:** follow [the deployment guide](docs/deploy.md) for the user's Cloudflare account and domain. Hosting uses D1, R2, Queues and a SQLite-backed Durable Object per inbox. Wrangler creates the Durable Object binding and migration during deployment. Local installation does not deploy the service.

Reuse the user's existing checkout, tools, credentials, and MCP configuration when available. If the repository is private, Git access must already be configured; report an access failure instead of changing repository visibility.

## Install with npm

Use Node.js 22.14 or newer and the scoped package `@upamune/agentpost`. The unscoped `agentpost` package is unrelated. The npm client has no runtime dependencies, native addons, or lifecycle installation scripts; Bun is unnecessary.

```sh
npm install --global --ignore-scripts @upamune/agentpost@X.Y.Z
agentpost --version
agentpost --help
```

Choose an actual published version in place of `X.Y.Z`. For agent-managed installation, first download `upamune-agentpost-VERSION.tgz` and verify it with the GitHub attestation/checksum procedure in [releases](docs/releases.md#verify-a-download), then install that exact verified local archive with `npm install --global --ignore-scripts /absolute/path/to/upamune-agentpost-VERSION.tgz`. Installation alone does not run the client or connect to a Worker. Stop on missing/invalid provenance. Preserve existing installations and use an authorized user-owned npm prefix; do not escalate to sudo to fix a permissions failure.

Record the version, absolute executable path, Node executable path, and `npm root --global`. The npm CLI does not autoload `.env` or working-directory configuration. Supply credentials privately as described below. For stdio MCP, either use the installed command with Node on the client's PATH, or set `command` to the absolute Node path and `args` to `["/ABSOLUTE_NPM_ROOT/@upamune/agentpost/cli.mjs", "mcp"]`. The latter also avoids Windows `.cmd` launcher differences. Existing MCP servers and credentials must be preserved.

## Install a standalone executable

Use a [GitHub Release](https://github.com/upamune/agentpost/releases) that lists a binary for the destination OS, architecture and Linux libc. Follow [release verification](docs/releases.md#verify-a-download) for the selected executable, `SHA256SUMS`, manifest and provenance bundle before running it. Older source-only releases, including v0.1.1, have no executable assets; use source installation if a suitable release is unavailable. Missing/invalid provenance stops installation.

The executable embeds Bun and supports both CLI commands and stdio MCP (`agentpost mcp`). It needs no Bun, Node.js or source checkout. Preserve existing installations; choose a new versioned directory and record its absolute executable path. After verification on macOS/Linux (with `version` and `asset` set by the verification procedure):

```sh
install_dir="/absolute/unused/path/agentpost-${version}"
mkdir "$install_dir" && install -m 755 "$asset" "$install_dir/agentpost" && \
  "$install_dir/agentpost" --version && "$install_dir/agentpost" --help
```

On Windows, create a new directory with `New-Item -ItemType Directory -ErrorAction Stop`, copy the verified `.exe` there as `agentpost.exe`, then run it using its absolute path. Add the selected directory to PATH only if requested. Client file arguments are relative to the current working directory; use absolute task paths when configuring agents.

The standalone executable does not autoload `.env`, `bunfig.toml`, `package.json` or `tsconfig.json` from its working directory. Inject credentials through the calling process or private MCP environment configuration. Worker deployment/local development still use the source checkout below.

## Install from source

Prerequisites: Git and [mise](https://mise.jdx.dev/getting-started.html). The CLI runs with Bun; Wrangler uses Node.js. The published npm client is `@upamune/agentpost`; standalone clients are separate release assets.

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
Text/HTML input files must be regular files of at most 512 KiB each; the combined request, including UTF-8 and JSON escaping, must also fit 512 KiB. Cursor checkpoint files are limited to 16 KiB and a 2048-character cursor. Invalid checkpoints stop monitoring and remain available for investigation.

Raw email and attachment downloads create new files with permissions 0600; choose an unused output path. Existing files and symlinks are refused. POSIX modes apply where supported; on Windows, use a private user directory with suitable ACLs.

## Install a verified release archive

For a versioned source installation, obtain the archive and provenance bundle from [GitHub Releases](https://github.com/upamune/agentpost/releases), and follow [release verification](docs/releases.md#verify-a-download) before extracting or running anything. Verify the publisher repository, signing workflow, and selected version tag; a checksum alone is insufficient. Missing or invalid provenance is a failed installation check, not permission to skip verification. The archive includes source and the frozen lockfile, not Bun, npm packages, or a standalone binary. After verification, extract it into a new persistent directory, install the pinned Bun/Node tools and frozen dependencies as above, and record the absolute source path and version. Cloning main remains available for development.

## Connect to an existing Worker

Obtain the API URL and a token through the user's private configuration or secret manager. Keep token values out of chat, shell tracing, logs, and committed configuration. All application environment variables use the `AGENTPOST_` prefix; see [the configuration table](docs/deploy.md#environment-variables).

Set `AGENTPOST_API_URL` to the Worker's HTTPS base URL and `AGENTPOST_API_TOKEN` to an inbox token for ordinary email access. In token mode, an admin token is required for provisioning and inbox administration. OAuth agents can provision/list their owned inboxes through native remote MCP. Inbox creation and token rotation return secrets; store those responses privately.
An inbox token allows sending as well as reading. Keep admin credentials outside ordinary agent sessions and use a separate inbox for each task. Follow `Retry-After` on HTTP 429; reuse the same idempotency key when retrying the same send.

Verify access without sending a message. With a supplied inbox UUID, use:

```sh
/absolute/path/to/agentpost inbox get INBOX_UUID
```

When the user authorizes provisioning, `inbox create --local-part research` chooses `research` on the configured domain; omit the option for three random English words joined by hyphens, e.g. `cedar-moon-river`. Use a separate inbox for each site and record its purpose in a private label. Optional `--notes TEXT` (or `--notes-file FILE`) and repeated `--site-url URL` store registration context. `inbox edit INBOX_UUID` updates only specified metadata; `--notes ''` and `--clear-urls` clear values. Editing needs administrator credentials or, through remote MCP `update_inbox`, an OAuth owner grant. Inbox tokens can read metadata. See [limits and migration requirements](docs/inbox-metadata.md). Existing names conflict even when disabled, and provisioning never reassigns them.

An admin token can instead use `inbox list --limit 1`. `health` also requires admin access, so its rejection does not mean an inbox token is invalid. If the URL, credentials, or inbox identity are missing, finish CLI installation and report the missing connection configuration. Do not create an inbox or send mail just to prove installation.

## Configure MCP

For native remote MCP OAuth, register the protected server URL and use the client's authorization flow; preserve other servers. Validate discovery, login, and tool access before reporting success. See [OAuth setup and roles](docs/authentication.md).

For token-based stdio MCP, merge an `agentpost` entry into the client's existing configuration. Preserve other servers. This is a configuration example, not a universal client config file location:

```json
{
  "mcpServers": {
    "agentpost": {
      "command": "/absolute/path/to/agentpost",
      "args": ["mcp"],
      "env": {
        "AGENTPOST_API_URL": "https://YOUR_WORKER.workers.dev",
        "AGENTPOST_API_TOKEN": "YOUR_INBOX_TOKEN"
      }
    }
  }
}
```

For Windows, use the absolute `agentpost.exe` path. Source installations can instead use `command: "mise"` with `args: ["exec", "--cd", "/absolute/path/to/agentpost", "--", "bun", "run", "src/cli.ts", "mcp"]`. Replace the path and inject credentials using the client's private configuration. Keep stdio stdout reserved for MCP messages. Validate connection and tool discovery through the actual client before reporting MCP as connected; writing configuration alone is not a connection test.

Clients supporting Streamable HTTP with preconfigured Bearer authentication can connect directly to `https://YOUR_WORKER.workers.dev/mcp`. Alternatively, compatible remote MCP clients can use Cloudflare Access Managed OAuth in oauth/both mode, without copying an API token. Protocol compatibility and the experimental MCP Events draft are documented in [MCP and Events](docs/mcp-events.md).

## Install the agent skill

The distributable skill lives in [`skills/agentpost`](skills/agentpost/SKILL.md). It describes inbox access, safe send retries, delivery states, and resumable event monitoring. Installing the skill does not install the CLI, configure credentials, or deploy a Worker. The default instructions are English, with a bundled [Japanese guide](skills/agentpost/references/guide.ja.md).

The bundled skill includes its own Agentpost icons. Keep its `assets/` directory when copying the skill; icon paths resolve within the installed skill.

With Node.js 22.20+ (the pinned skill installer's requirement), run this in the project that should use the skill. The CLI itself still supports Node.js 22.14+. The example targets Codex; replace `codex` with `claude-code` for Claude Code, or select the actual client supported by the installer. Use project scope unless the user requests a global installation.

```sh
npm exec --yes --ignore-scripts --package=skills@1.7.4 -- \
  skills add upamune/agentpost --skill agentpost --agent codex --yes
```

If Bun/mise is already available, `mise exec bun@1.4.4 -- bunx skills@1.7.4 add upamune/agentpost --skill agentpost --agent codex --yes` remains an alternative. If a local checkout is already available, replace `upamune/agentpost` with its absolute path. `--skill agentpost` selects the consumer skill and excludes this repository's development skills. Confirm the installed skill and its references are present in the target project. The installer does not receive API tokens.

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

GitHub Actions runs checks and the Worker dry-run build on pushes to `main` and on pull requests. `mise run build` invokes `wrangler deploy --dry-run`; it does not deploy or publish CLI binaries. The additional CI executable matrix compiles and smoke-tests all seven platforms. Version-tag releases attach them with signed provenance; see [releases](docs/releases.md). Build locally with `mise run cli:build PLATFORM --verify-reproducible` and test with `mise run cli:smoke --platform PLATFORM`; commit source/package/lock/config/build-script changes first. Local full checks use `mise install` followed by `mise run ci`.

Report the executable or checkout path, CLI version, skill installation scope, and which connection or local checks passed. List missing configuration without exposing values. Distinguish source installation, MCP connection, local Worker verification, and production deployment. Production mail requires the domain, Email Routing, Email Sending Beta, DNS, credentials, and explicit real send/receive checks in the deployment guide. Run a real send test only with a user-specified recipient; installation alone does not authorize sending mail.

## Diagnose domain configuration

After hosting setup, or when investigating authentication/deliverability, use MCP `check_domain` or CLI `domain check` with authorized administrator access. Do not automatically replace inbox/OAuth-agent credentials with admin credentials. Inspect pass/warning/fail/unknown findings and remediation; diagnostics do not guarantee delivery. Do not send a test message without a specified, authorized recipient or automatically edit DNS. See [setup and limits](docs/domain-diagnostics.md).

## Send and reply with attachments

Repeat `--attach /absolute/path/report.pdf` on `send` or `reply`. Use `attachment upload INBOX_ID FILE` to upload first, then `--attachment-id ID` to reuse saved IDs. MCP uses `upload_attachment` followed by `send_email` or `reply_email`. Both the Worker and client must support attachments. Read [formats, limits, retention, and retries](docs/outbound-attachments.md). Real recipients and content still require the user's authorization.

## Send keys and inbox webhooks

CLI `--idempotency-key` and MCP `idempotency_key` are optional: omission generates UUIDv4 before submission and exposes it in success results and send failures. Save that key with the exact request and pass it explicitly for retries. Repeating without a key creates a new send. Preassigning and persisting a key before the first call remains preferable for crash-resilient agent workflows.

Use `webhook set INBOX_UUID --webhook-url HTTPS_URL` or MCP `set_webhook` only when the user authorized that receiver and the operator already configured its allowed origin, encryption key and dedicated queue. Save the returned signing secret privately; receivers must verify signatures and deduplicate. Installing the skill does not authorize a new external notification destination. Follow [webhook installation and verification](docs/webhooks.md); configuration alone does not prove receiver connectivity.

## Optional incoming forwarding

Forwarding is administrator-only and off by default. Before enabling it, apply `0007_forwarding.sql`, verify the authorized destination in Cloudflare, and privately configure the Worker Secret `AGENTPOST_FORWARD_ALLOWED_DESTINATIONS`. Use `agentpost forwarding set --destination EMAIL` for the global default; per-inbox `set INBOX_ID --destination EMAIL`, `off INBOX_ID` and `inherit INBOX_ID` override it. Use only user-authorized destinations. This does not authorize forwarding existing messages or initiating a real mail test. See https://github.com/upamune/agentpost/blob/main/docs/forwarding.md for native-session limits, outcome inspection and acknowledgment.
