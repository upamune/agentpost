---
name: verify-outbound-safety
description: Check agentpost outbound claims, provider calls, inbox disabling, and stale-send recovery with TLA+ and real D1 replay tests. Use when changing deliver, queue dispatch, inbox disabling, provider outcome handling, or Cron recovery.
---

# Verify outbound safety

Run from the agentpost source checkout. This is development verification, not the installed email-operation skill.

## Coverage and synchronization

Last confirmed against product commit `ed15d43123471a7de7c89be7f77f5380da136dc9`.

| Code | What the model covers |
| --- | --- |
| `src/outbound.ts:82` `deliver` | Conditional claim, separate inbox read, provider call, conditional outcome write |
| `src/outbound.ts:17` `cloudflareSend` | Outcome classes; ambiguous responses may already have accepted mail |
| `src/maintenance.ts:20` `recoverStaleSends` | Independent stale `sending` to `unknown` update |
| `src/api.ts:177` inbox PATCH | Independent inbox disable update |
| `src/index.ts:27` queue handler | Duplicate jobs and worker interruption |
| `migrations/0001_mail.sql` | One durable outbox row; unique inbox/idempotency key |

Inspect changes since that commit, including uncommitted changes, before trusting a pass. Each SQL statement is atomic in the model; reads, network calls, and writes are separate actions. Update `verification/outbound/Outbound.tla` when the implementation's guards or ordering change. Advance the sync commit here and in `check.ts` only after checking every covered action against the new code.

## Run and interpret

1. Install the pinned tools: `mise install java github:tlaplus/tlaplus`. Install application dependencies with `mise exec -- bun install --frozen-lockfile`.
2. Run `mise run verify:outbound`. It checks each invariant separately and runs the real-code replays. Evidence is under `.verification/outbound/`, including `result.json`, per-property TLC logs, and replay results. Exit 1 means a violated property or failed replay; a tool error is reported separately and is not evidence of a product bug.
3. Read every model result with pstack `/statechart`. Follow that skill's current instructions, work on a copy outside the repo, and use `Outbound.chart.cfg` for the small chart scope. Inspect each PNG and its numbered path. `Outbound.map.mjs` supplies labels. Do not infer the full check's bound from the chart's smaller scope.
4. Replay every finding through `replay.test.ts`. Its D1 and APIs are real local implementations. Only the scheduling gate, clock, and provider are controlled. The provider is a stub; never substitute live email sending.
5. Run `mise run verify:outbound:selftest`. It must catch a removed conditional-claim guard both in the model and in a scratch copy of the real `deliver` code. The scratch copy is deleted automatically. Return to the baseline and rerun the main check.

The current baseline has two failing stop-related properties and two corresponding failed replays. Do not weaken them, classify them as tool failures, or fix product code during an investigation-only request. A future change that resolves a finding should make its property and replay pass; update the report after observing that result.

## Bounds and evidence

One outbox request, one inbox, two possible queue consumers, and at most eight claims. Charts use at most two claims. 429 and explicit provider rejections are assumed not to accept a message. A stalled worker may resume after Cron's two-minute threshold; that assumption is necessary only for the stale-worker finding. No fairness, delivery/liveness, global exactly-once, D1 rollback, cryptographic, MIME, authorization, or whole-program proof is claimed.

See `docs/formal-verification.md` for the properties, counterexamples, qualifications, and checked evidence. For accumulated drift from changes that skipped this skill, use pstack `/maintain-formal-verification-skill`.
