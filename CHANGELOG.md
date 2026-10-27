# Changelog

[English](CHANGELOG.md) | [日本語](CHANGELOG.ja.md)

## 0.3.0

- Forward incoming mail with global defaults and per-inbox inherit/custom/off settings. Retain originals, restrict destinations to verified operator-approved addresses, and block marked forwarding loops.
- Add signed per-inbox received-email webhooks, encrypted receiver settings, delivery history, bounded retries and dedicated queues.
- Generate UUIDv4 idempotency keys when omitted, return them on client success/failure, and preserve selected keys across retries.
- Issue unnamed inboxes with three random English words joined by hyphens, while retaining custom names. Store and edit optional notes and multiple registration URLs through the API, CLI and MCP.
- Preserve exact attachment bytes with Base64 raw MIME sending, including text-file line endings, Unicode names, alternative bodies and threaded replies.
- Improve D1 indexes and bounded recovery, R2 integrity/size checks and stream cleanup, and mail/webhook queue isolation. Require explicit deployment credentials and document scoped Cloudflare permissions.
- Expand bounded formal verification, real-storage race replays and mutation tests. Distribute the updated CLI/MCP and seven standalone executables through signed releases and npm OIDC publishing.
- Add the bilingual product website, supplied logo and continuous alias animation. Explain receiving, forwarding, sending and replying in the README and website.

Existing hosts must apply migrations through `0009_recovery_indexes.sql` and update queue bindings before deploying. Forwarding and webhooks remain disabled until configured by the operator. Updating a CLI does not update a Worker; see [installation](INSTALL.md) and [deployment](docs/deploy.md).

## 0.2.0

- Send and reply with private, inbox-scoped attachments through the API, CLI, and MCP. Validate content integrity before dispatch, preserve idempotency, and document file limits, retention, and the absence of antivirus scanning.
- Add attachment safety models, deliberate mutation checks, and real-storage/actor-handoff regressions to CI.
- Lead the README with the product workflow, four badges, and a 30-second local fixture demo.

## 0.1.4

- Bound local mail and checkpoint file reads, reject devices/FIFOs, and enforce the complete serialized API request limit before submission. Preserve Unicode mail and stop on invalid saved checkpoints.
- Report stale `sending` requests through authenticated health without changing their outcomes or resending mail.
- Retain executable CI artifacts only for release assembly, select the exact npm archive version, and document Node-only skill installation.

## 0.1.3

- Fix the npm publisher's local archive path so npm does not interpret it as a GitHub shorthand. Add an actual offline npm publish dry-run regression using the workflow's maintained file argument.
- Publish the first npm CLI/MCP version through GitHub OIDC with provenance. Version 0.1.2's signed GitHub assets remain immutable.

## 0.1.2

- Publish the dependency-free Node.js CLI/MCP client as `@upamune/agentpost` with GitHub OIDC Trusted Publishing and npm provenance. Installation requires no lifecycle scripts or Bun.
- Distribute seven standalone executables for macOS, Linux glibc/musl, and Windows x64 with signed provenance and native smoke tests.

## 0.1.1

- Isolate each TLC JVM's temporary directory to prevent concurrent formal checks from overwriting and deleting shared standard-module files. Add real-tool regressions for file preservation and concurrent extraction. Verification properties and product mail behavior are unchanged.

## 0.1.0

- Initial signed source distribution for self-hosted email addresses, sending, receiving, CLI, and MCP.
- Add continuous security fuzzing, dependency and workflow scans, bounded formal verification, and an immutable release pipeline with verifiable SLSA provenance.
