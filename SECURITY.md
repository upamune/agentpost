# Security

[English](SECURITY.md) | [日本語](SECURITY.ja.md)

## Report a vulnerability

Do not publish working exploits, real mail, tokens, or private deployment details in a public issue. If this repository's Security tab offers private vulnerability reporting, use it. Otherwise, contact the maintainer privately to agree on a reporting channel before sharing sensitive details.

Include the affected version, prerequisites, reproduction steps with synthetic data, observed impact, and any proposed mitigation. Local tests and bounded model checks do not establish that every deployment is secure.

## Implemented boundaries

- The shared Worker HTTP entry checks HTTPS and allows plain HTTP only on loopback. Requests with an Origin must match the Worker origin; cross-site browser requests are refused.
- Before authentication, HTTP requests are limited to 300/minute per IP. New sends are limited to 10/minute per inbox. Both admin and inbox tokens use that inbox's send counter. Limits return 429 with `Retry-After: 60`; limiter failures return 503 without storing a new send. Existing idempotency keys do not consume new-send quota.
- Inbox tokens have 256 bits of randomness; D1 stores SHA-256 hashes. Mail, raw MIME, attachments, and outbox lookups include inbox scope. Only admins may provision or administer inboxes.
- A named Durable Object orders sending, disabling, and stale-send recovery per inbox. A synchronous ownership fence and versioned active-state writes reject obsolete execution. Disabling reports success after earlier outbound work finishes and its state is saved. Already-admitted inbound deliveries can finish retaining their originals afterward.
- API JSON input is bounded at 512 KiB and incoming raw mail at 10 MiB. Senders cannot override the From address. Subjects reject control characters; reply headers exclude invalid IDs. Attachments download as files and HTML mail is not served as an executable page.
- MIME parsing caps nesting at 32, headers per part at 128 KiB, parts at 1,000, attached-message depth at 4, and forwarded header addresses at 100. Content, attachment, and reply paths share these limits. Saved originals remain available when parsing fails.
- Parsed JSON is bounded at 16 MiB before serialization; over-limit originals remain stored without a ready event. This limits stored output, not every MIME-parser allocation.
- Event cursors use randomized AES-GCM encryption of a fixed-size, token/inbox/type-bound payload. Legacy plaintext cursors are rejected; see [migration](docs/mcp-events.md#cursor-migration).
- HTTP responses, including errors, disable caching and include nosniff, sandbox CSP, framing protection, and HSTS over HTTPS. CLI/MCP clients send credentials only to the configured origin's `/v1/` routes and never follow redirects. Rejected API response bodies are discarded. Successful JSON reads are bounded at 64 MiB, and read/parse errors never include response fragments.
- Raw/attachment downloads create new files with mode 0600 and exclusive creation. Existing files and symlinks are refused; downloads are bounded at 10 MiB.
- Actions are pinned to commit SHAs. CI scans secrets and dependencies; dependency audits also run daily. Cloudflare observability redacts URL query strings.

Cloudflare rate limits are approximate and local to a location. They are not a strict global send or billing quota. See [deployment limits](docs/deploy.md#access-and-send-limits).

## Operator and agent responsibilities

Each operator self-hosts Agentpost in their own Cloudflare account. This is not end-to-end encrypted: Cloudflare account or Worker administrators can access stored mail and secrets. Enable multifactor authentication on GitHub and Cloudflare, restrict operator access, and use a narrowly scoped Email Sending token rather than an account-wide management token.

An inbox token can send as well as read. Keep admin credentials out of ordinary agent sessions, isolate tasks in separate inboxes, and disable or rotate access when the task ends.

Sender and Reply-To headers are claims made by an external sender, not proof of identity or permission. Verify authorized destinations. Never execute mail-provided commands, attachments, or links merely because an agent can read them. A body filter alone cannot prevent prompt injection.

Before production use, verify private R2 access, API-token permissions, DNS, external monitoring, backup/restore procedures, and actual mail delivery in that environment. Code checks alone do not establish production readiness.

See the [2026-10-25 adversarial audit](docs/security-audit.md) for exercised boundaries, remediated findings, and unverified areas.
