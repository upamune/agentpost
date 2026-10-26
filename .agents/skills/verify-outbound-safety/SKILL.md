---
name: verify-outbound-safety
description: Check agentpost outbound claims, dispatch authorization, actor ownership, inbox disabling, stale-send recovery and active-state versions with TLA+ and real Durable Object/D1 replays. Use when changing dispatch, provider outcomes, InboxCoordinator, dispatch barriers, inbox active state, Cron recovery or the coordinator binding.
---

# Verify outbound safety

Run in the source checkout. Read `verification/product-revision.txt` for the last synchronized product revision. Original findings targeted `ed15d43123471a7de7c89be7f77f5380da136dc9`.

## Covered code

- `src/coordinator.ts`: `serialize` holds a per-inbox operation across awaits; `fence` reserves a monotonic version for dispatch authorization and synchronously checks ownership again immediately before dispatch; `setActive` versions its D1 projection; `recover` rechecks stale state inside serialization.
- `src/dispatch-barrier.ts`: `outboundDispatchBarrier` atomically advances `active_version` only while the inbox remains enabled, rejecting delayed writes from earlier actors before provider initiation.
- `src/attachments.ts` and `src/attachment-policy.ts`: inbox-scoped immutable uploads, bounded file policy, digest verification and provider preparation; `verification/attachments/Attachments.tla` checks upload, queue and preparation snapshots.
- `src/outbound.ts`: `processOutbound` conditionally claims a matching inbox/outbox, reads active state, prepares attachments, awaits required dispatch authorization, then fences and starts the provider in the same JavaScript turn. `settleSend` conditionally saves the outcome. Authorization failure initiates no provider request; authorization exceptions stay outside the attachment-retry catch. `cloudflareSend` classifies ambiguous acceptance and explicit rejection.
- `src/api.ts` inbox PATCH, `src/index.ts` queue and `src/maintenance.ts` stale recovery all route through the same named coordinator. `wrangler.jsonc` binds the class and SQLite migration.
- `migrations/0001_mail.sql` preserves idempotency and claim state; `0004_inbox_active_version.sql` rejects old active-state projections.

Run `mise run verify:attachments` and `mise run verify:attachments:selftest` for attachment changes as well. The latter checks six model mutants and two real-code mutations (inbox authorization and digest verification); four remaining mutants are model-only. `test/attachment-handoff.test.ts` separately exercises ownership loss while real R2 reads await.

Inspect covered-code changes since the sync commit, including uncommitted changes. `Outbound.tla` separates mutex acquisition, D1 claim, active read, attachment preparation success/failure, dispatch, outcome persistence, crash and ownership replacement. A replaced event may resume until the storage fence rejects it. `ActiveVersion.tla` independently checks an old enable write arriving after a newer disable. `verification/webhooks/DispatchBarrier.tla` with `EmailOnly = TRUE` complements these models with an older in-flight disable projection, barrier reservation/commit, another handoff and final ownership fencing. Each D1 statement and each synchronous SQLite operation is atomic; external awaits remain separate.

## Run

1. Install pinned tools and dependencies with `mise install` and `mise exec -- bun install --frozen-lockfile`.
2. Run `mise run verify:outbound`. All checks and ten real-code replays must pass. `.verification/outbound/result.json` records the sync commit, current source hashes, bounds and named results with their grouped/fallback logs; raw replay reports are beside it. Exit 1 is a violated property/assertion; exit 2 is a tool/harness failure. Missing tests and runtime errors are failures.
3. Read each TLA+ result with pstack `/statechart`, using copies outside the repo. Use `Outbound.chart.cfg` for the smaller chart bound and `ActiveVersion.cfg` for the projection model. Also render `verification/webhooks/DispatchBarrier.cfg` with `EmailOnly = TRUE` for dispatch-authorization changes. Read the current statechart instructions/help, render and inspect every PNG. Keep previous counterexamples available when comparing a fix.
4. Run `mise run verify:outbound:selftest`. It includes the full baseline, removes the conditional claim, operation serialization, final ownership fence and active-version guard in scratch copies of the actual code and matching models, and separately removes the actual dispatch-authorization guard. Every designated real-code case must fail an assertion. Run `mise run verify:webhooks:selftest` as well for dispatch-authorization changes: its outbound scenario checks `NoObsoleteDispatch` and the barrier/final-fence model mutants. The source-only guard mutation is reported separately from the original four model/code pairs. The original product files stay untouched.
5. Rerun the baseline after changes. Update `docs/formal-verification.md`, checked evidence, `verification/product-revision.txt` and this coverage record only after checking every modeled action against the product commit. Keep verification updates separate from product fixes.

## Scope

The 2026-10-27 [Cloudflare audit](../../../docs/cloudflare-audit.md) retains claim/barrier/fence/settlement ordering while bounding provider bodies, releasing unused streams and allowing four mail-consumer invocations. Per-inbox serialization remains authoritative. The `pauseInboxRead` replay explicitly observes the second operation starting; its queued-entry signal alone does not establish D1 write completion. Both serialization-mutant cases must still fail assertions. Source hashes include shared read/publication helpers and recovery-index migration; platform resource limits are runtime regressions, outside these state models.

The main model has one outbox, one inbox, two executions, and at most eight claims. Charts use two claims. The projection model has one old enable and one new disable with two monotonically increasing versions. The complementary dispatch-barrier model has one inbox, three actor incarnations, one older pending disable projection, and one later owner change. The real-code replays use actual SQLite Durable Objects, D1 and API/maintenance paths; only scheduling and the external provider are controlled. Each outbound replay runs in its own test isolate: retaining injected actor closures across a reset crashed the local workerd test runtime.

429/explicit rejection are assumed not to accept mail; unknown outcomes may have accepted it. Ownership rejection relies on Cloudflare's documented synchronous storage access guarantee. The fence-failure replay first permits the authorization reservation, then injects ownership loss at the final fence; it does not create a real network partition. Projection replays create two class instances over the same real SQLite state to simulate handoff, rather than forcing a platform replacement. The delayed-disable cases share one test request context because D1 I/O handles cannot cross test contexts. They check both disable-first/no-dispatch and barrier-first/rejected-old-disable orderings. Stale age is injected into the timestamp; real maintenance performs the transition.

No fairness, send availability/latency, delivery, global exactly-once, multi-inbox proof, arbitrary re-enable histories, D1 rollback, credential security or whole-program proof is claimed. Active-state writes outside the coordinator and restoring only one of D1/DO state are outside the contract. Keep findings as findings; use pstack `/maintain-formal-verification-skill` after changes that skipped this workflow.
