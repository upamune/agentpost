---
name: verify-outbound-safety
description: Check agentpost outbound claims, actor ownership, inbox disabling, stale-send recovery and active-state versions with TLA+ and real Durable Object/D1 replays. Use when changing dispatch, provider outcomes, InboxCoordinator, inbox active state, Cron recovery or the coordinator binding.
---

# Verify outbound safety

Run in the source checkout. Last synchronized with product commit `7800ab3f588d4357185b497332d790d56145ce96`, following the original findings at `ed15d43123471a7de7c89be7f77f5380da136dc9`.

## Covered code

- `src/coordinator.ts`: `serialize` holds a per-inbox operation across awaits; `fence` synchronously checks ownership immediately before dispatch; `setActive` versions its D1 projection; `recover` rechecks stale state inside serialization.
- `src/outbound.ts`: `processOutbound` conditionally claims a matching inbox/outbox, reads active state, fences and starts the provider in the same JavaScript turn, then conditionally saves the outcome. `cloudflareSend` classifies ambiguous acceptance and explicit rejection.
- `src/api.ts` inbox PATCH, `src/index.ts` queue and `src/maintenance.ts` stale recovery all route through the same named coordinator. `wrangler.jsonc` binds the class and SQLite migration.
- `migrations/0001_mail.sql` preserves idempotency and claim state; `0004_inbox_active_version.sql` rejects old active-state projections.

Inspect covered-code changes since the sync commit, including uncommitted changes. `Outbound.tla` separates mutex acquisition, D1 claim, active read, dispatch, outcome persistence, crash and ownership replacement. A replaced event may resume until the storage fence rejects it. `ActiveVersion.tla` independently checks an old enable write arriving after a newer disable. Each D1 statement and each synchronous SQLite operation is atomic; external awaits remain separate.

## Run

1. Install pinned tools and dependencies with `mise install` and `mise exec -- bun install --frozen-lockfile`.
2. Run `mise run verify:outbound`. All checks and eight real-code replays must pass. `.verification/outbound/result.json` records the sync commit, current source hashes, bounds and results; per-check logs and raw replay reports are beside it. Exit 1 is a violated property/assertion; exit 2 is a tool/harness failure. Missing tests and runtime errors are failures.
3. Read each TLA+ result with pstack `/statechart`, using copies outside the repo. Use `Outbound.chart.cfg` for the smaller chart bound and `ActiveVersion.cfg` for the projection model. Read the current statechart instructions/help, render and inspect every PNG. Keep previous counterexamples available when comparing a fix.
4. Run `mise run verify:outbound:selftest`. It removes the conditional claim, operation serialization, ownership fence and active-version guard in scratch copies of the actual code and matching models. Every variant must fail its designated checks. The original product files stay untouched.
5. Rerun the baseline after changes. Update `docs/formal-verification.md`, checked evidence, `verification/product-revision.txt` and this coverage record only after checking every modeled action against the product commit. Keep verification updates separate from product fixes.

## Scope

The main model has one outbox, one inbox, two executions, and at most eight claims. Charts use two claims. The projection model has one old enable and one new disable with two monotonically increasing versions. The real-code replays use actual SQLite Durable Objects, D1 and API/maintenance paths; only scheduling and the external provider are controlled. Each outbound replay runs in its own test isolate: retaining injected actor closures across a reset crashed the local workerd test runtime.

429/explicit rejection are assumed not to accept mail; unknown outcomes may have accepted it. Ownership rejection relies on Cloudflare's documented synchronous storage access guarantee. The fence-failure replay injects that failure; it does not create a real network partition. The projection replay creates two class instances over the same real SQLite state to simulate handoff, rather than forcing a platform replacement. Stale age is injected into the timestamp; real maintenance performs the transition.

No fairness, send availability/latency, delivery, global exactly-once, multi-inbox proof, arbitrary re-enable histories, D1 rollback, credential security or whole-program proof is claimed. Active-state writes outside the coordinator and restoring only one of D1/DO state are outside the contract. Keep findings as findings; use pstack `/maintain-formal-verification-skill` after changes that skipped this workflow.
