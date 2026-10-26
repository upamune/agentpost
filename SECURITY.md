# Security

[English](SECURITY.md) | [日本語](SECURITY.ja.md)

## Report a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/upamune/agentpost/security/advisories/new). Do not publish working exploits, real mail, tokens, or private deployment details in a public issue. If that channel is temporarily unavailable, contact the maintainer privately before sharing sensitive details.

Include the affected version, prerequisites, reproduction steps with synthetic data, observed impact, and any proposed mitigation. Local tests and bounded model checks do not establish that every deployment is secure.

## Implemented boundaries

- The shared Worker HTTP entry checks HTTPS and allows plain HTTP only on loopback. Authenticated requests with an Origin must match the Worker origin; cross-site browser requests are refused.
- Before authentication, HTTP requests are limited to 300/minute per IP. New sends are limited to 10/minute per inbox. Both admin and inbox tokens use that inbox's send counter. Limits return 429 with `Retry-After: 60`; limiter failures return 503 without storing a new send. Existing idempotency keys do not consume new-send quota.
- OAuth/both mode verifies Cloudflare Access RS256 assertions against a configured team JWKS and application audience, including expiry, required claims, and application-token type. An explicit identity allowlist assigns admin or owned-inbox agent access; arbitrary email/role headers cannot grant permissions. Remote MCP uses Managed OAuth discovery and client-managed login/refresh. See [authentication](docs/authentication.md).
- Inbox tokens have 256 bits of randomness; D1 stores SHA-256 hashes. Mail, raw MIME, attachments, and outbox lookups include inbox scope. Admins can provision and administer inboxes; allowlisted OAuth agents can provision and use their own active inboxes. Inbox tokens cannot provision or administer inboxes.
- Custom mailbox names are validated and normalized before a domain-bound, atomic unique insert. Conflicts never replace credentials, including for disabled inboxes; admins and allowlisted OAuth agents can allocate names within their provisioning permissions.
- A named Durable Object orders sending, disabling, and stale-send recovery per inbox. A synchronous ownership fence and versioned active-state writes reject obsolete execution. Disabling reports success after earlier outbound work finishes and its state is saved. Already-admitted inbound deliveries can finish retaining their originals afterward.
- API JSON input is bounded at 512 KiB and incoming raw mail at 10 MiB. Senders cannot override the From address. Subjects reject control characters; reply headers exclude invalid IDs. Attachments download as files and HTML mail is not served as an executable page.
- MIME parsing caps nesting at 32, headers per part at 128 KiB, parts at 1,000, attached-message depth at 4, and forwarded header addresses at 100. Content, attachment, and reply paths share these limits. Saved originals remain available when parsing fails.
- Parsed JSON is bounded at 16 MiB before serialization; over-limit originals remain stored without a ready event. This limits stored output, not every MIME-parser allocation.
- OAuth/both mode requires an independent cursor encryption secret. Refreshed JWTs retain stable cursor scope; role or encryption-key changes invalidate checkpoints.
- Event cursors use randomized AES-GCM encryption of a fixed-size, token/inbox/type-bound payload. Legacy plaintext cursors are rejected; see [migration](docs/mcp-events.md#cursor-migration).
- HTTP responses, including errors, disable caching and include nosniff, sandbox CSP, framing protection, and HSTS over HTTPS. CLI/MCP clients send credentials only to the configured origin's `/v1/` routes and never follow redirects. Rejected API response bodies are discarded. Successful JSON reads are bounded at 64 MiB, and read/parse errors never include response fragments.
- Raw/attachment downloads create new files with mode 0600 and exclusive creation. Existing files and symlinks are refused; downloads are bounded at 10 MiB.
- Actions are pinned to commit SHAs. CI scans secrets and dependencies; dependency audits also run daily. Cloudflare observability redacts URL query strings.

Cloudflare rate limits are approximate and local to a location. They are not a strict global send or billing quota. See [deployment limits](docs/deploy.md#access-and-send-limits).

## Operator and agent responsibilities

Public OAuth resource discovery alone allows permissive CORS; mail/API/MCP routes keep their origin checks. Validation outages fail closed without falling back from a bad Access assertion to a token.

Each operator self-hosts Agentpost in their own Cloudflare account. This is not end-to-end encrypted: Cloudflare account or Worker administrators can access stored mail and secrets. Enable multifactor authentication on GitHub and Cloudflare, restrict operator access, and use a narrowly scoped Email Sending token rather than an account-wide management token.

An inbox token can send as well as read. OAuth agents can provision and use active owned inboxes; agents sharing an Access identity share its ownership. JWT verification is not individual-token introspection: use appropriate Access session lifetimes and reconnect/drain old streams during policy deployments. Keep admin credentials out of ordinary agent sessions, isolate tasks in separate inboxes, and disable or rotate access when the task ends.

Sender and Reply-To headers are claims made by an external sender, not proof of identity or permission. Verify authorized destinations. Never execute mail-provided commands, attachments, or links merely because an agent can read them. A body filter alone cannot prevent prompt injection.

Before production use, verify private R2 access, API-token permissions, DNS, external monitoring, backup/restore procedures, and actual mail delivery in that environment. Code checks alone do not establish production readiness.

See the [2026-10-26 security/reliability review](docs/security-review-2026-10-26.md) and [2026-10-25 adversarial audit](docs/security-audit.md) for exercised boundaries, remediated findings, and unverified areas.

## Diagnostic egress

Admin domain diagnostics use fixed Cloudflare API/DoH HTTPS origins and reject redirects. Body size, query count and network deadlines are bounded; resolution/schema failures remain unknown. A dedicated provider diagnostic token goes only to the API and never falls back to sending credentials. DNS content and upstream error bodies are not reflected in reports. See [diagnostic details](docs/domain-diagnostics.md).

## Continuous analysis

See [continuous security checks](docs/security-checks.md) for CodeQL, OSV, Bun audit, Dependency review, Dependabot, zizmor, OpenSSF Scorecard, secret protection and formal verification. Report completion and a green badge do not by themselves establish that all alerts are resolved.

## Outbound attachments

The [attachment policy](docs/outbound-attachments.md) uses private, inbox-scoped, immutable R2 objects. Dispatch verifies size, digest, and format before its final ownership check and provider initiation. Extension/signature allowlisting is not antivirus scanning; allowed PDFs and images can still be malicious. Uploads, including unused files, are retained without automatic expiry. Operators provide any required scanning, retention, and backups. Files are not automatically sent to external scanners.
