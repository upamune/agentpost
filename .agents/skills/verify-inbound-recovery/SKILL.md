---
name: verify-inbound-recovery
description: Check agentpost raw MIME retention, R2-to-D1 index repair, poison metadata isolation, recovery attention and parsed-before-ready ordering. Use when changing receive, indexRaw, repairRawIndex, parseMessage, inbound queue handling or maintenance republishing.
---

# Verify inbound recovery

Run in the source checkout. The synchronized product revision is recorded in `verification/product-revision.txt`; compare against that revision, including uncommitted changes.

## Covered code

`src/inbound.ts` persists original MIME in `receive` before indexing/publishing; `indexRaw` validates metadata through `rawIdentityMatches` and `validRawEnvelope` and inserts without replacing message state; `rawMetadata` recovers stored envelope metadata; `rawRecoveryPage` reads the saved cursor and page. `repairRawIndex` records attention before moving its cursor; `parseMessage` uses `src/bounded-json.ts` to enforce a 16 MiB escaped UTF-8 JSON limit before persisting parsed R2 content and committing ready state. Over-limit input retains raw without a ready event. `src/maintenance.ts` independently republishes inbound/outbound and webhook work. `src/index.ts` serially calls `handleQueueMessage`, which publishes durable webhook work after parsing and acknowledges afterward; `src/api.ts` exposes unresolved raw recovery failures in admin health. The message/event schema and `migrations/0003_raw_recovery.sql` preserve observable state and attention.

Inspect covered-code changes since the sync commit, including uncommitted changes. `verification/inbound/Inbound.tla` starts after successful raw persistence: it models separately the index write, attention deletion, cursor commit, queue publication, parsed put, ready commit and acknowledgement. Faults can interrupt index/attention/cursor/parse work. Invalid metadata records attention and permits later pages to progress.

## Run

1. Install pinned tools/dependencies with `mise install` and `mise exec -- bun install --frozen-lockfile`.
2. Run `mise run verify:inbound`. All recovery and forwarding invariants, `EventuallyReady` and 24 real-code replays (eight recovery plus sixteen forwarding cases) must pass. `.verification/inbound/result.json` records source hashes, bounds, assumptions and replay results. Exit 1 is a property/assertion failure; exit 2 is a tool/harness failure. Failed runtime startup and missing tests cannot count as a pass.
3. Read each TLA+ result with pstack `/statechart`, following its current instructions/help. Work on a copy outside the repo and use `Inbound.chart.cfg` for the smaller diagram. Render and inspect each PNG. A temporal-property failure has a repeating trace rather than a numbered bug chart; retain that trace.
4. Run `mise run verify:inbound:selftest`. Eight model/real-code mutation pairs must detect stopping at poisoned metadata, deleting original MIME, omitting the parsed put, skipping durable attention, overwriting an admission snapshot, reclaiming forwarding, resetting ambiguous forwarding and bypassing destination policy. Mutants live in a scratch directory; product files stay untouched.
5. Rerun the baseline. Update the report, evidence, `verification/product-revision.txt` and sync commit only after comparing each modeled operation with the code. Keep verification updates separate from product fixes.

## Bounds and assumptions

Three originals, two with valid metadata/MIME within parser and parsed-output limits and one poisoned metadata object; one object per page; at most two transient faults. The liveness property assumes a finite stable corpus, finitely many failures, and weak fairness of successful Cron, queue and parse operations. Chart scope uses zero transient faults. Real replays also check orphaned inbox restoration, queue failure, duplicate events and failed attention persistence.

The model starts after R2 put succeeds; it does not promise SMTP delivery before that point or recovery of invalid metadata. It abstracts bounded queue duplicates as membership and does not prove parser correctness, cryptography, malformed MIME recovery, arbitrary concurrent cursor writers, D1 rollback, backups, deployment or whole-program correctness. Real-code tests cover the receive/index persistence boundary and parsed-write/ready-write failures with actual R2/D1, not copies of product code. For verification drift use pstack `/maintain-formal-verification-skill`.

The 2026-10-25 size preflight changes no persistence ordering. Permanent size rejection is outside the successful-parse liveness assumption; `test/adversarial-mail.test.ts` separately checks raw retention, missing parsed output, pending state and no event. The ready mutation tracks the bounded serializer call.

Webhook queue publication failure must not roll back ready mail: its notification row commits atomically with readiness and Cron can republish it. Run `mise run verify:webhooks:selftest` and `test/webhooks.test.ts` when changing that boundary. The inbound model abstracts this additional queue stage; webhook state safety is checked by the separate webhook models and actual-code replays.

## Native forwarding extension (2026-10-26)

The 2026-10-27 [Cloudflare audit](../../../docs/cloudflare-audit.md) adds bounded reads in `src/mail-storage.ts`, checksummed R2 puts, and `src/queue-jobs.ts` validation/batch publication. Recovery replays observe `sendBatch`; raw/index/parsed/ready/ack ordering and model bounds remain unchanged. Forwarding recovery handles at most 100 rows per stale status per Cron; the one-message model retains the same recovery action. Query plans, byte limits and batch failure isolation are checked by `test/cloudflare-storage.test.ts` and `test/queue-contracts.test.ts`, outside the TLA+ proof.

`src/forwarding-store.ts` admits mail with a single global/per-inbox policy snapshot, restores immutable forwarding intents during `indexRaw`, and reserves one D1 row per message. `src/inbound.ts` now uses a conditional R2 put to preserve the first admission's metadata, indexes/publishes retained mail, and then tries native forwarding without letting forwarding errors discard mail. `src/forwarding-policy.ts` limits native destinations to operator-allowed external mailboxes and captures off/blocked decisions. `src/forwarding.ts` validates pending work, conditionally claims once while active, invokes native `message.forward`, conditionally settles, and recovers stale intents/claims without retry. Settings affect future admissions; a forwarding claim admitted before disable may finish afterward. This differs from the serialized outbound-send disable contract.

`Forwarding.tla` separately models two SMTP handlers for one MIME identity, three destination categories (off/trusted/unapproved), configuration changes, a conditional original snapshot, index insertion, a pending read, a claim, a native call, settlement, interruption and recovery. Six finite invariants cover types, original-before-dispatch, immutable snapshots, trusted destinations, at most one native call and no second claim after uncertainty. `test/forwarding.test.ts` supplies sixteen actual-code cases to the inbound replay baseline. The historical D1-loss fixtures now remove forwarding state as well as message indexes; their initial foreign-key failure was harness drift, not a product counterexample. Models assume atomic R2/D1 writes, no D1 rollback and a trusted Cloudflare native-forwarding implementation; they do not prove native verification, real SMTP delivery, arbitrary histories, remote forwarding-loop freedom or policy cancellation across old Worker deployments.

Four additional model/code mutation pairs check conditional R2 writes, conditional claims, unknown recovery and destination allowlisting. Counterexample PNGs in `verification/inbound/evidence/forwarding/` were rendered with pstack statechart from scratch copies and visually inspected. Green means the guarded current model excludes the intentionally unsafe variant; these are mutation counterexamples, not vulnerabilities accepted in the product. Follow the reproduction example in `docs/formal-verification.md`.
