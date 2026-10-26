# Agentpost

Create as many email addresses as your AI agents need. Send and receive mail on your own domain with a self-hosted Cloudflare API, CLI, and MCP server.

```sh
npm install --global @upamune/agentpost
agentpost --version
agentpost --help
```

Requires Node.js 22.14 or newer. This package contains one bundled CLI/MCP client, no runtime dependencies, and no installation scripts. Bun and a source checkout are unnecessary. The executable name is `agentpost`; the unrelated unscoped npm package `agentpost` is not this project.

Set `AGENTPOST_API_URL` and `AGENTPOST_API_TOKEN` through your private process environment. Keep credentials out of chat and committed configuration. The client does not automatically load `.env` or working-directory configuration. Use an inbox token for ordinary mail access, and preserve the same idempotency key when inspecting/retrying a send. Never automatically resend an unknown outcome.

For stdio MCP, configure the absolute installed `agentpost` path with `args: ["mcp"]` and private environment variables. MCP stdout contains protocol messages only.

This client does not deploy a Worker. Follow the [English installation guide](https://github.com/upamune/agentpost/blob/main/INSTALL.md), [Japanese installation guide](https://github.com/upamune/agentpost/blob/main/INSTALL.ja.md), and [release verification](https://github.com/upamune/agentpost/blob/main/docs/releases.md). Published versions use GitHub OIDC Trusted Publishing and npm provenance.
