# Formal verification of sending and recovery

[English](formal-verification.md) | [日本語](formal-verification.ja.md)

On 2026-10-25, the [pstack](https://github.com/cursor/plugins/tree/9580c23696ac8d7abed0c166f2f9918800afb819/pstack) workflow checked outbound disabling/recovery and inbound raw-index recovery. TLA+ / TLC 2.19 explores operation orderings; replays use actual local Durable Objects, D1, and R2.

The synchronized product revision is recorded in [`verification/product-revision.txt`](../verification/product-revision.txt). The original investigation targeted `ed15d43123471a7de7c89be7f77f5380da136dc9`. Two outbound races and a poisoned-raw scan blockage found there were fixed. Every current check requires success; no known invariant failure is accepted to make CI pass.

## Results

| Property                                                              | Model checking                      | Real-code evidence                                              |
| --------------------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------- |
| An outbox request is not accepted twice                               | No counterexample                   | Duplicate jobs call provider once                               |
| Uncertainty does not create a new send attempt                        | No counterexample                   | Replaying unknown work does not dispatch                        |
| No new external call starts while disabled after successful disabling | Old model fails; fixed model passes | Disable waits for earlier work and rejects later sends          |
| Old execution cannot dispatch after Cron marks it unknown             | Old model fails; fixed model passes | Recovery waits for live work and recovers interrupted execution |
| An old enable write cannot undo a newer disable                       | No counterexample                   | Two instances sharing SQLite reject a delayed write             |
| Repair/parsing retains saved original MIME                            | No counterexample                   | Original survives D1, parsed-R2, and queue failures             |
| Ready commits only after parsed content persists                      | No counterexample                   | Recovery from parsed-write and ready-write failures             |
| Poison metadata cannot indefinitely block valid later originals       | Conditional EventuallyReady holds   | Repair crosses real R2 pages                                    |
| Repair cursor cannot advance before failure attention persists        | No counterexample                   | Failed attention persistence retains scan position              |

Eight outbound and eight inbound verification replays supplement the ordinary tests. External sending is stubbed; no real mail is sent.

## F1 and F2: disable/recovery races

Previously, a sender could read active state, pause, and start dispatch after disabling completed. A sender delayed for more than two minutes could also resume its first dispatch after Cron marked it unknown. Its accepted response then left the database unknown.

Sends, admin activity changes, and stale-send recovery now share the inbox-ID-derived `InboxCoordinator`. Its ordering spans D1/provider awaits. Disable returns success only after earlier send work completes and disabled state persists. Cron uses the same order and rechecks state/time.

Under [Cloudflare ownership constraints](https://developers.cloudflare.com/durable-objects/platform/known-issues/#global-uniqueness), a replaced Object may resume from external I/O without detecting replacement until storage access. Synchronous SQLite fencing immediately before dispatch detects that case; no await separates fencing and call initiation.

![Disable counterexample and fix](../verification/outbound/evidence/bug-1.png)

![Unknown-recovery counterexample and fix](../verification/outbound/evidence/bug-2.png)

The [old/fixed model comparison](../verification/outbound/evidence/stories.md) includes paths 3/4 where the same two issues overlap; those are not additional independent bugs. Original counterexamples were replayed against old code with real D1. Current tests pause at the same boundaries and ensure disable/recovery cannot overtake dispatch.

Disabling can wait for prior I/O. A timeout does not establish success. No guarantee recalls already initiated traffic or prevents its later arrival/acceptance.

## Protecting activity during Object replacement

An old Object's D1 enable write may still be in progress when a replacement disables the inbox. SQLite's monotonic sequence is compared against D1 `active_version`; delayed older writes fail rather than undo newer state.

[ActiveVersion.tla](../verification/outbound/ActiveVersion.tla) starts with version-1 enable and version-2 disable already issued, then explores D1 arrival order. This small model does not prove version issuance or replacement itself; real-code replays cover the handover logic.

![Versioned writes reject stale updates](../verification/outbound/evidence/active-version/bug-1.png)

The counterexample in this figure disables version comparison in a mutant. It does not describe a failure in the fixed code.

## F3: poison metadata blocks raw scanning

Previously, any `indexRaw` failure exited `repairRawIndex` before cursor persistence. Each run retried the same original, indefinitely delaying valid originals on later pages.

The fix durably records invalid metadata, missing inboxes, and index-write failures in `raw_recovery_failures` before advancing. Failed attention persistence still prevents advancement. Originals remain for retry on the next cycle; successful repair clears attention. Unresolved attention yields admin health 503. Cron saves progress before reporting failure.

Raw repair, interrupted-send recovery, inbound republishing, and outbound republishing are attempted independently. A failed stage does not prevent other republishing attempts.

![Recovery from retained originals](../verification/inbound/evidence/chart.png)

Parsed R2 put and D1 ready commit are separate modeled steps. Real-code tests also check that duplicate parsing/index repair cannot demote ready to pending or duplicate received events.

## Bounds and assumptions

- **Outbound:** one inbox, one outbox, two actors, at most eight claims. Separate mutex acquisition, D1 claim, activity read, synchronous fence/dispatch, result save, interruption, and replacement. Provider 429/explicit rejection mean not accepted; unknown may include acceptance. Backoff abstracts runnable order, not numeric timing or clock synchronization. No fairness, send availability, or latency proof.
- **Versioned updates:** two requests and two versions, not arbitrary activity histories.
- **Inbound:** three retained originals (two valid, one poison), one object per page, at most two transient faults. Separate index insertion, attention deletion, cursor commit, queue publish, parsed put, ready commit, and ack. EventuallyReady assumes a finite stable corpus, finitely many faults, and weak fairness of successful Cron/queue/parse actions. Valid MIME must also fit the parser/output limits; permanently over-limit originals are retained for attention, not promised ready.
- SQL statements and synchronous SQLite operations are atomic. The checks do not prove independent D1/DO rollback safety, direct admin SQL, cryptography, authentication, parser correctness, real delivery, or whole-program absence of bugs.

Replays call product APIs/classes and real local D1/R2. Tests age claim timestamps and pause around awaits. Ownership-loss tests inject a failed fence; they do not create real Cloudflare network partitions. Version tests instantiate two classes on shared SQLite, rather than reproducing platform replacement itself.

The security hardening adds a 16 MiB parsed-JSON preflight before parsed put. It introduces no new persistence step: rejection retains raw and never commits ready. The model's successful-parse action describes inputs within limits; a permanent size violation is outside EventuallyReady's valid-input assumption. The dedicated regression checks raw retention, absent parsed output, pending state, and no event. See the [security audit](security-audit.md).

The OAuth addition changes HTTP authentication and inbox authorization, not the modeled send, disable, recovery, raw-index, or parse ordering. The existing models and real-code replays were rerun unchanged. OAuth discovery, JWT validation, inbox ownership, and cursor refresh are covered separately by `test/oauth.test.ts`; these are regression tests, not a formal proof of authentication. See [authentication](authentication.md).

## Rerun and CI

```sh
mise install
mise exec -- bun install --frozen-lockfile
mise run verify
# Include ordinary checks, build, and secret scanning:
mise run ci
```

Individual tasks are `verify:outbound`, `verify:inbound`, and each area's `:selftest`. Normal checks return 0 on success, 1 on property/assertion failure, and 2 on tool/harness failure. Missing cases and runtime startup failures never count as success.

Selftests inspect scratch copies with conditional claims, serialization, fencing, version checks, poison continuation, original retention, parsed persistence, or attention persistence broken. A mutation passes only when both the model and real-code check detect it. Product files stay intact.

GitHub Actions has separate outbound/inbound jobs for models, replays, and mutations. TLC's jar is SHA-256 checked, and Actions are SHA pinned. `.verification/outbound/` and `.verification/inbound/` results/logs are retained as CI artifacts for 14 days. Snapshots live in `verification/*/evidence/results.json`.

Outbound replays run in separate isolates: leaving injected Object closures across reset crashed local workerd. Isolation does not ignore product exceptions or failures.

## Diagrams and code synchronization

Generate diagrams with pstack `/statechart` and visually inspect PNGs. Outbound diagrams compare old/current models with at most two claims. The inbound diagram uses zero transient faults, smaller than the full two-fault check. The activity diagram compares the current guard to a mutant without it. Diagram state counts do not describe full-check bounds.

Read the bundled statechart skill's current instructions before regenerating. Copy models, `*.chart.cfg`, and `*.map.mjs` outside the repository. The outbound baseline is `Outbound.tla` / `Outbound.chart.cfg` at `b50dd4b`. Return generated `summary.json`, `stories.md`, Mermaid, and PNG files to the relevant evidence directory.

Follow [verify-outbound-safety](../.agents/skills/verify-outbound-safety/SKILL.md) for outbound changes and [verify-inbound-recovery](../.agents/skills/verify-inbound-recovery/SKILL.md) for inbound changes. Use pstack `/maintain-formal-verification-skill` for drift. Earlier counterexamples were product bugs; mutex/fencing/version model changes reflected the fix. No invariant was weakened to remove a counterexample.
