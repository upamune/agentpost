---
name: verify-webhook-safety
description: Verify agentpost inbox webhook configuration, receive notifications, dispatch barriers, delivery claims, or generated idempotency key changes against bounded models and actual Workers replays.
---

# Verify webhook and generated-key safety

Run from this source checkout. The synchronized product revision is recorded in `verification/product-revision.txt`; compare covered code with that revision and include uncommitted changes before relying on old evidence.

## Run and inspect

1. Read `docs/webhooks.md` and `verification/webhooks/README.md` for source mappings, race findings, bounds, and assumptions. Preserve inbox ownership, encrypted configuration identity, atomic ready-event capture, immutable delivery identity, and conditional claims/settlement.
2. Install pinned tools with mise and dependencies with `mise exec -- bun install --frozen-lockfile`.
3. Run `mise run verify:webhooks:selftest`. It includes the complete baseline: seven bounded scenarios, eight real Workers/D1/SQLite replays, twelve model mutants, and five real-code mutants. Require the intended invariant or assertion to fail for every mutant; missing cases, startup failures, or incomplete TLC output must fail verification. Exit 1 means a property/assertion failure; exit 2 means a tool/harness failure.
4. Read each TLA+ result with pstack `/statechart`, following `.agents/skills/statechart/SKILL.md`. Generate into a scratch copy, render and visually inspect each PNG, and retain compact counterexample paths in `verification/webhooks/evidence/`. Do not mistake an unrendered Mermaid file for inspected evidence.
5. Run `mise run verify:outbound:selftest` when changing the shared dispatch barriers or coordinator, and `mise run verify:inbound:selftest` when changing readiness publication or recovery. Run `mise run ci` for all areas and ordinary checks.
6. After a product commit, refresh `verification/product-revision.txt`, source hashes and evidence snapshots. Keep verification updates separate from product changes. Use `/maintain-formal-verification-skill` to distinguish drift from product bugs.

## Boundaries

The 2026-10-27 [Cloudflare audit](../../../docs/cloudflare-audit.md) batches Cron publication through `src/queue-jobs.ts` and uses indexed bounded due/stale queries. Publication failure still leaves the same durable delivery identity for a later run. The model's queued membership abstracts duplicates and partial/ambiguous batch publication; it does not prove batch atomicity, queue latency or database query cost. Real-storage regressions check these API boundaries separately.

`Configuration`, `Delivery`, `Events`, `Idempotency`, and `DispatchBarrier` model configuration versions/tombstones, claims and stale completion, inbox-bound notification identity, client key retention, and delayed D1 projections across actor replacement. The barrier has separate webhook and email scenarios. It must reserve a fresh actor sequence, conditionally raise D1 projection versions, then perform a final synchronous ownership fence immediately before starting HTTP; an await between that final fence and request initiation is unsafe.

Models assume atomic D1 statements/batches/triggers and monotonic SQLite ownership fencing. Bounds include two inboxes, two representative claims/calls, and three coordinator incarnations for the barrier. They prove finite safety properties, not arbitrary histories, elapsed-time behavior, eventual delivery, cryptographic correctness, or whole-program correctness. Keep independent HMAC vectors, encryption binding, trusted-origin/redirect policy, authorization, retry bounds, and CLI/MCP contract tests. UUID collision resistance and receiver deduplication are assumptions. Unknown email outcomes must never become automatic retries merely because webhook retries are allowed.
