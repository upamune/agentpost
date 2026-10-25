---
name: verify-inbound-recovery
description: Check agentpost raw MIME retention, R2-to-D1 index repair, poison metadata isolation, recovery attention and parsed-before-ready ordering. Use when changing receive, indexRaw, repairRawIndex, parseMessage, inbound queue handling or maintenance republishing.
---

# Verify inbound recovery

Run in the source checkout. Last synchronized with product commit `741a80e7d576a33746c1b1b2919364104094fc2e`.

## Covered code

`src/inbound.ts` persists original MIME in `receive` before indexing/publishing; `indexRaw` validates metadata through `rawIdentityMatches` and `validRawEnvelope` and inserts without replacing message state; `rawMetadata` recovers stored envelope metadata; `rawRecoveryPage` reads the saved cursor and page. `repairRawIndex` records attention before moving its cursor; `parseMessage` uses `src/bounded-json.ts` to enforce a 16 MiB escaped UTF-8 JSON limit before persisting parsed R2 content and committing ready state. Over-limit input retains raw without a ready event. `src/maintenance.ts` independently republishes inbound/outbound work. `src/index.ts` serially calls `handleQueueMessage`, which acknowledges after parsing; `src/api.ts` exposes unresolved raw recovery failures in admin health. The message/event schema and `migrations/0003_raw_recovery.sql` preserve observable state and attention.

Inspect covered-code changes since the sync commit, including uncommitted changes. `verification/inbound/Inbound.tla` starts after successful raw persistence: it models separately the index write, attention deletion, cursor commit, queue publication, parsed put, ready commit and acknowledgement. Faults can interrupt index/attention/cursor/parse work. Invalid metadata records attention and permits later pages to progress.

## Run

1. Install pinned tools/dependencies with `mise install` and `mise exec -- bun install --frozen-lockfile`.
2. Run `mise run verify:inbound`. All invariants, `EventuallyReady` and eight real-code replays must pass. `.verification/inbound/result.json` records source hashes, bounds, assumptions and replay results. Exit 1 is a property/assertion failure; exit 2 is a tool/harness failure. Failed runtime startup and missing tests cannot count as a pass.
3. Read each TLA+ result with pstack `/statechart`, following its current instructions/help. Work on a copy outside the repo and use `Inbound.chart.cfg` for the smaller diagram. Render and inspect each PNG. A temporal-property failure has a repeating trace rather than a numbered bug chart; retain that trace.
4. Run `mise run verify:inbound:selftest`. Model and real-code mutations must detect stopping at poisoned metadata, deleting original MIME, omitting the parsed put, and skipping durable attention. Mutants live in a scratch directory; product files stay untouched.
5. Rerun the baseline. Update the report, evidence, `verification/product-revision.txt` and sync commit only after comparing each modeled operation with the code. Keep verification updates separate from product fixes.

## Bounds and assumptions

Three originals, two with valid metadata/MIME within parser and parsed-output limits and one poisoned metadata object; one object per page; at most two transient faults. The liveness property assumes a finite stable corpus, finitely many failures, and weak fairness of successful Cron, queue and parse operations. Chart scope uses zero transient faults. Real replays also check orphaned inbox restoration, queue failure, duplicate events and failed attention persistence.

The model starts after R2 put succeeds; it does not promise SMTP delivery before that point or recovery of invalid metadata. It abstracts bounded queue duplicates as membership and does not prove parser correctness, cryptography, malformed MIME recovery, arbitrary concurrent cursor writers, D1 rollback, backups, deployment or whole-program correctness. Real-code tests cover the receive/index persistence boundary and parsed-write/ready-write failures with actual R2/D1, not copies of product code. For verification drift use pstack `/maintain-formal-verification-skill`.

The 2026-10-25 size preflight changes no persistence ordering. Permanent size rejection is outside the successful-parse liveness assumption; `test/adversarial-mail.test.ts` separately checks raw retention, missing parsed output, pending state and no event. The ready mutation tracks the bounded serializer call.
