# agentpost

[English](CLAUDE.md) | [日本語](CLAUDE.ja.md)

Issue random or custom-named email addresses on the operator's own domain and let AI agents send and receive through a Cloudflare API, CLI, and MCP server.

- Manage tools with mise. Use `mise run format|lint|typecheck|test|build|ci`; install dependencies with `mise exec -- bun install --frozen-lockfile`.
- Pin Actions to SHAs with pinact. Manage tasks with `mise exec -- backlog task add|list|show|move <id> done`.
- This project is a Workers API/MCP service. Do not assume a Web UI or introduce TanStack Start.
- CLI entry: `mise exec -- bun run cli --help`. Before changing MCP or notifications, read [MCP and Events](docs/mcp-events.md). Verify the finalized MCP core specification separately from the pinned Events draft.
- For agent installation/distribution changes, update [INSTALL.md](INSTALL.md) and `skills/agentpost/`. Installed skills must work without source-checkout-relative paths.
- Before changing mail processing, send state, or recovery, read [operations](docs/operations.md). Preserve raw-first persistence and conditional send claims.
- Cloudflare Email Sending is Beta. Never automatically resend an unknown outcome. Queue publication and provider acceptance do not prove delivery.
- Follow [deployment](docs/deploy.md). Do not report production readiness until domain configuration, authentication, and real send/receive checks pass.
- Local tests, dry-run builds, and local Wrangler checks are allowed. Real email tests require a user-specified recipient first.
- Write maintained documentation in English by default and provide Japanese `*.ja.md` counterparts. Update both when behavior, examples, or limits change; preserve upstream and generated artifact languages.

For send, disable, or recovery changes, follow `.agents/skills/verify-outbound-safety/SKILL.md`. For raw persistence, index repair, parsing order, or republishing changes, follow `.agents/skills/verify-inbound-recovery/SKILL.md`. Run `mise run verify`, or `mise run ci` for verification plus the regular checks.
