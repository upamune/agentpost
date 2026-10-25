# Contributing

[English](CONTRIBUTING.md) | [日本語](CONTRIBUTING.ja.md)

Use [issues](https://github.com/upamune/agentpost/issues) for bugs and proposed features, and pull requests for changes. English and Japanese reports are welcome. For vulnerabilities, use the [private reporting channel](SECURITY.md), with synthetic mail and credentials in reproductions.

Before starting a large change, describe the problem, expected behavior, and compatibility impact in an issue. Keep each PR focused and explain the trigger, resulting behavior, and validation. Maintainers review proposed changes before merging. Independent review is encouraged; the current single-maintainer project cannot guarantee review by a second person.

## Development checks

Install the pinned tools and dependencies, then run the checks:

```sh
mise trust
mise install
mise exec -- bun install --frozen-lockfile
mise run ci
mise run security:dependencies
```

Use strict TypeScript, the existing formatter/linter, SHA-pinned Actions, and English code comments and application text. Update English and Japanese documentation together. Add regression tests for bug fixes and meaningful tests for new behavior; tests should exercise the public contract or security invariant. Run the relevant formal verification when changing inbox ownership, send claims, active-state fencing, persistence, parsing, or recovery; see [AGENTS.md](AGENTS.md) and [formal verification](docs/formal-verification.md).

Security fuzzing runs on PRs, main, and daily. See [security checks](docs/security-checks.md) for replay instructions. Keep discovered inputs synthetic and minimize them before committing a regression. Report exploitable findings privately before proposing a public fix that reveals them.

`mise run ci` also checks cognitive and cyclomatic complexity with pinned [cccc](https://github.com/moznion/cccc). Use `mise run complexity` for the gate or `mise run complexity:report` for the full JSON measurements. Every function identity has limits of 8 cognitive / 6 cyclomatic, with no existing exceptions. Baseline changes require review; never regenerate or increase allowances just to pass. See [complexity checks](docs/complexity.md) for scope, identities, reports, and limitations.

Tests use synthetic provider responses and local storage; builds are dry runs. Keep real mail, API tokens, and production data out of fixtures. Use a full-history clone for secret scanning and also inspect staged changes with `mise exec -- gitleaks git --staged --redact --no-banner`.

MCP and Events changes follow the [pinned contracts](docs/mcp-events.md). Generated evidence and vendored files retain their original language. The Undici/Zod overrides replace vulnerable versions selected by Cloudflare test tooling; reconsider them when upstream adopts fixes: [Undici advisory](https://github.com/advisories/GHSA-xjj6-f33q-929c), [Zod advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5).

## Compatibility and releases

Preserve raw-first mail retention, per-inbox authorization, explicit token/OAuth modes, and conditional send claims. A provider acceptance is not proof of delivery; an uncertain send outcome must never cause an automatic replacement send. Each operator manages their own domain and Cloudflare account; test changes locally unless a real recipient and live operation were authorized.

Only the maintainer publishes releases after required checks pass. Source archives have checksums and signed provenance; use the verification procedure in [releases](docs/releases.md). Changes to dependencies and development tooling receive the same review as runtime code. No automated dependency merge is enabled. Contributions remain under the repository's MIT license.
