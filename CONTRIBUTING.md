# Contributing

[English](CONTRIBUTING.md) | [日本語](CONTRIBUTING.ja.md)

Use [Issues](https://github.com/upamune/agentpost/issues) for bugs and proposals. Follow [SECURITY.md](SECURITY.md) for vulnerability reports.

Clone the repository and follow the [local setup](README.md#try-it-locally), then run:

```sh
mise run format
mise run ci
```

Tests use provider stubs and local storage. Keep real mail, real API tokens, and production data out of fixtures. Builds are dry runs. `mise run secrets` scans locally available Git history, so use a full-history clone; inspect staged changes with `mise exec -- gitleaks git --staged --redact --no-banner` as well.

Describe the problem, resulting behavior, and validation in your PR. Mail changes must preserve [operations invariants](docs/operations.md) and follow the relevant inbound/outbound verification skill. MCP and Events changes must follow the [pinned contracts](docs/mcp-events.md).

Write maintained documentation in English by default and provide the corresponding `*.ja.md` translation. Keep examples, limits, security guidance, and relative links consistent across both languages. Generated verification evidence and vendored upstream files retain their source language.

Audit dependency updates with `mise exec -- bun audit`. The overrides in `package.json` replace vulnerable Undici/Zod versions pinned by Miniflare and the Cloudflare Vitest plugin with patched versions of the same major. Reconsider them when upstream adopts the fixes: [Undici advisory](https://github.com/advisories/GHSA-xjj6-f33q-929c), [Zod advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5).
