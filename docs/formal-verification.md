# Formal verification of sending and recovery

[English](formal-verification.md) | [日本語](formal-verification.ja.md)

On 2026-10-25, the [pstack](https://github.com/cursor/plugins/tree/9580c23696ac8d7abed0c166f2f9918800afb819/pstack) workflow checked outbound disabling/recovery and inbound raw-index recovery. TLA+ / TLC 2.19 explores operation orderings; replays use actual local Durable Objects, D1, and R2.

The synchronized product revision is recorded in [`verification/product-revision.txt`](../verification/product-revision.txt). The original investigation targeted `ed15d43123471a7de7c89be7f77f5380da136dc9`. Two outbound races and a poisoned-raw scan blockage found there were fixed. Every current check requires success; no known invariant failure is accepted to make CI pass.

## Results

| Property                                                              | Model checking                      | Real-code evidence                                                 |
| --------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------ |
| An outbox request is not accepted twice                               | No counterexample                   | Duplicate jobs call provider once                                  |
| Uncertainty does not create a new send attempt                        | No counterexample                   | Replaying unknown work does not dispatch                           |
| No new external call starts while disabled after successful disabling | Old model fails; fixed model passes | Disable waits for earlier work and rejects later sends             |
| Old execution cannot dispatch after Cron marks it unknown             | Old model fails; fixed model passes | Recovery waits for live work and recovers interrupted execution    |
| An old enable write cannot undo a newer disable                       | No counterexample                   | Two instances sharing SQLite reject a delayed write                |
| An old pending disable cannot invalidate authorized dispatch ordering | No counterexample                   | Disable-first blocks dispatch; barrier-first rejects the old write |
| Repair/parsing retains saved original MIME                            | No counterexample                   | Original survives D1, parsed-R2, and queue failures                |
| Ready commits only after parsed content persists                      | No counterexample                   | Recovery from parsed-write and ready-write failures                |
| Poison metadata cannot indefinitely block valid later originals       | Conditional EventuallyReady holds   | Repair crosses real R2 pages                                       |
| Repair cursor cannot advance before failure attention persists        | No counterexample                   | Failed attention persistence retains scan position                 |

Ten outbound and eight inbound verification replays supplement the ordinary tests. External sending is stubbed; no real mail is sent.

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

## Complexity refactor synchronization

Product revision `ee8c98f11baf9eb04bf3e2c37c10a7aeb372e32f` splits provider response classification, conditional outcome persistence (`settleSend`), raw metadata validation, and escaped JSON sizing into smaller operations. Comparing every covered change since `54b677e5f77962db60e3da0ce9a88b3fafdf9cf1` found no change to a modeled atomic step, state guard, or external-await boundary. API ownership/naming/domain-diagnostic changes since that revision do not change the modeled ordering. The outcome is **in sync** for outbound, inbound and active-version checks; no new product bug was found by this run.

The conditional D1 claim and outcome updates retain their predicates. The ownership fence still immediately precedes sender initiation without an await. Original retention, durable attention before cursor advancement, parsed R2 put before ready, and queue acknowledgement ordering remain unchanged. Models retain all properties and bounds; only their code references move. Replay population/completion validation and diagram label selection were factored into helpers without changing failure criteria. The old/new outbound mappings produce identical labels for 23,520 input combinations.

The full models and sixteen real-code replays pass. All eight deliberately broken safety variants are detected in both models and real code. Separately, 33 contract regressions and 500,000 security-fuzz cases cover CLI requests, DNS TXT grammar, MCP error mapping, bounded JSON and credential boundaries. These remain tests, rather than formal proofs of those components.

Fresh smaller-bound diagrams were rendered and visually inspected: [outbound](../verification/outbound/evidence/refactor/chart.png), [inbound](../verification/inbound/evidence/refactor/chart.png), and [versioned activity](../verification/outbound/evidence/refactor-active-version/chart.png). Their adjacent Mermaid sources, `summary.json`, and `stories.md` record the checked scopes. They have no broken rule; the historical bug diagrams above remain available. To reproduce, copy each current model, its `*.chart.cfg` (or `ActiveVersion.cfg`), and mapping outside the repository, then run the bundled statechart command with `from-spec MODEL --config CONFIG --map MAP --cover --png`. Use the current help's TLC/Java setup.

### Further reduction to 8/6

Product revision `741a80e7d576a33746c1b1b2919364104094fc2e` further separates URL/identity validation, queue-item handling, stored raw metadata/page lookup, parsed content defaults, and provider outcome fields. All covered changes since `ee8c98f11baf9eb04bf3e2c37c10a7aeb372e32f` preserve the modeled atomic persistence steps and guards. Async helpers add promise continuations but move no operation across the claim/fence/save, parsed-put/ready, attention/cursor, or parse/ack boundaries. Queue items remain sequential. The outcome is **in sync** for all three models, with the same bounds and properties and no new counterexample.

The full verification and all eight model/real-code safety mutations pass again. Three additional real-storage queue regressions cover mixed-success batches, retry delay/capping, and duplicate delivery without duplicate events. The local queue-result helper omits per-message delay, so those tests also spy on the actual public `retry` call. The smaller-bound diagrams above were regenerated and inspected; the outbound mappings still agree across 23,520 combinations. Authentication and parsers remain covered by regression/fuzz tests, outside the formal proof's scope.

## Rerun and CI

```sh
mise install
mise exec -- bun install --frozen-lockfile
mise run verify
# Include ordinary checks, build, and secret scanning:
mise run ci
```

Individual tasks are `verify:outbound`, `verify:inbound`, `verify:attachments`, `verify:webhooks`, and each area's `:selftest`. Each selftest includes its complete baseline, so CI runs it once per area and saves both reports. Compatible properties share a traversal; after a grouped failure, each property is checked separately before reporting named outcomes. Normal checks return 0 on success, 1 on property/assertion failure, and 2 on tool/harness failure. Missing cases and runtime startup failures never count as success. See [CI performance](ci-performance.md) for measurements and preserved checks.

Each TLC JVM receives a private `java.io.tmpdir` inside the runner's scratch directory. The pinned tool extracts standard modules by basename and deletes them on exit; sharing the system temporary directory caused a reproduced parser failure during parallel checks. Real-TLC regressions check inherited-file preservation and distinct extraction paths under concurrent execution. Models, properties, bounds, and failure handling remain unchanged.

Selftests inspect scratch copies with conditional claims, serialization, fencing, version checks, poison continuation, original retention, parsed persistence, or attention persistence broken. Each original outbound/inbound mutation passes only when both its model and real-code check detect it. Outbound selftests additionally remove dispatch authorization and require its designated real-code assertion to fail; its complementary model is checked in the webhooks area. Attachment selftests separately report six model and two source mutations, as described below. Product files stay intact.

GitHub Actions has separate outbound, inbound, attachment, and webhook jobs for models, replays, and mutations. TLC's jar is SHA-256 checked, and Actions are SHA pinned. `.verification/outbound/`, `.verification/inbound/`, `.verification/attachments/`, and `.verification/webhooks/` results/logs are retained as CI artifacts for 14 days. Snapshots live in `verification/*/evidence/results.json`.

Outbound replays run in separate isolates: leaving injected Object closures across reset crashed local workerd. Isolation does not ignore product exceptions or failures.

## Diagrams and code synchronization

Generate diagrams with pstack `/statechart` and visually inspect PNGs. Outbound diagrams compare old/current models with at most two claims. The inbound diagram uses zero transient faults, smaller than the full two-fault check. The activity diagram compares the current guard to a mutant without it. Diagram state counts do not describe full-check bounds.

Read the bundled statechart skill's current instructions before regenerating. Copy models, `*.chart.cfg`, and `*.map.mjs` outside the repository. The outbound baseline is `Outbound.tla` / `Outbound.chart.cfg` at `b50dd4b`. Return generated `summary.json`, `stories.md`, Mermaid, and PNG files to the relevant evidence directory.

Follow [verify-outbound-safety](../.agents/skills/verify-outbound-safety/SKILL.md) for outbound changes and [verify-inbound-recovery](../.agents/skills/verify-inbound-recovery/SKILL.md) for inbound changes. Use pstack `/maintain-formal-verification-skill` for drift. Earlier counterexamples were product bugs; mutex/fencing/version model changes reflected the fix. No invariant was weakened to remove a counterexample.

## Outbound attachments (2026-10-26)

Product revision `cf0404a` adds private attachment uploads and verified preparation before the final ownership fence. `Outbound.tla` now has separate preparation success/failure actions, preserving the original bounds and five safety invariants. All eight original real-code replays and four outbound model/code mutation pairs pass. An additional real Durable Object/D1/R2 regression pauses the attachment read, replaces the actor, completes disable and stale-send recovery, then resumes the old event: the ownership fence rejects it, no provider call occurs, and `unknown` is preserved.

[`Attachments.tla`](../verification/attachments/Attachments.tla) checks four bounded scenarios:

| Scenario             | Concrete states | Checked properties                                                                                                               |
| -------------------- | --------------: | -------------------------------------------------------------------------------------------------------------------------------- |
| Concurrent uploads   |               9 | Conditional writes never rewrite an existing upload                                                                              |
| Inbox isolation      |              24 | Foreign-inbox references are not accepted; accepted payload matches the saved key                                                |
| Idempotency race     |              45 | Competing payloads cannot both be accepted under one key                                                                         |
| Preparation snapshot |              28 | Missing/unavailable/corrupt/substituted bytes cannot be dispatched; verified in-memory bytes remain bound to the queued identity |

Bounds are two inboxes, two immutable files, two concurrent requests, one idempotency key, and one storage fault. Content/metadata hashes are idealized as collision-free; D1 uniqueness and conditional R2 writes are atomic, and a GET returns one coherent object snapshot. Provider uncertainty and fencing are checked separately by the outbound model. This is bounded model checking, not a cryptographic, MIME/parser, malware, delivery, or whole-program proof.

Six deliberate model mutants remove conditional puts, inbox binding, idempotency hash equality, integrity, availability, or snapshot use; all produce the expected invariant counterexample. Two real-code scratch mutations remove API inbox authorization or SHA-256 verification, and both fail their designated assertions. The other four are model-only mutations. Real-storage tests cover corrupt or missing objects, immutable upload reuse, idempotency conflicts after changes, pre-dispatch storage retries, threaded reply attachments, limits, maximum-size remote MCP uploads, and actor handoff.

The pstack statecharts were rendered and visually inspected for all four scenarios: [uploads](../verification/attachments/evidence/upload/chart.png), [isolation](../verification/attachments/evidence/isolation/chart.png), [queue race](../verification/attachments/evidence/queue/chart.png), and [preparation](../verification/attachments/evidence/prepare/chart.png). Their Mermaid, stories, configs, summaries, source hashes, and mutation results are retained in [evidence](../verification/attachments/evidence/). The refreshed outbound chart is under [attachment preparation](../verification/outbound/evidence/attachments/).

```sh
mise run verify:attachments
mise run verify:attachments:selftest
# All models, mutation checks, and ordinary checks:
mise run ci
```

CI runs an `attachments` formal matrix job and retains raw logs/reports. To regenerate a chart, copy `Attachments.tla`, the selected evidence `Attachments.cfg`, and the matching `Upload.map.mjs`, `Queue.map.mjs`, or `Attachments.map.mjs` into a scratch directory. Run `node .agents/skills/statechart/scripts/statechart.mjs from-spec /scratch/Attachments.tla --map /scratch/Attachments.map.mjs --cover --png` from a checkout with the pinned tools; render outputs outside the repository and inspect each PNG.

## Delayed projections and dispatch authorization

An old coordinator can reserve a version and start a D1 disable write before handoff, while the replacement reads an enabled inbox. The old write can then finish and acknowledge disabling before the replacement's final ownership fence. Ownership alone does not reject that stale active-state snapshot.

After attachment preparation, outbound dispatch now requires `outboundDispatchBarrier` to atomically advance `active_version` while the inbox remains enabled. If disabling committed first, authorization fails and no provider request starts. If authorization committed first, the older disable projection is superseded and cannot acknowledge success. A final synchronous ownership fence still runs after that awaited D1 write and immediately before provider initiation.

[`DispatchBarrier.tla`](../verification/webhooks/DispatchBarrier.tla), with `EmailOnly = TRUE`, complements the existing outbound state machine. It separates an old in-flight projection, handoff, preparation, barrier reservation/commit, a second handoff, a newer disable, the final fence, and dispatch. Bounds are one inbox, three coordinator incarnations, one old disable projection, and one later owner change. `NoObsoleteDispatch` checks that stale preparation cannot initiate a send. Removing the D1 barrier or the final fence produces a model counterexample; `verify:webhooks:selftest` runs both mutants.

Two additional outbound replays use the actual coordinator classes over shared SQLite and D1: disable commits after the new actor's active read, or the new actor's barrier commits before the old disable. They run in separate isolates and controlled request contexts; they simulate handoff rather than force Cloudflare replacement. `verify:outbound:selftest` also removes the actual authorization guard and requires the first replay to fail an assertion. This source-only mutation is reported separately from the four existing model/code mutation pairs. The final-fence replay lets the authorization reservation succeed, then injects ownership loss at the final fence.

The same bounded model with `EmailOnly = FALSE` also checks webhook configuration replacement. The email scenario explores 39 distinct states; the webhook scenario explores 77. The webhook area additionally models versioned configuration, durable event/delivery identity, conditional claims and settlement, and generated/explicit idempotency-key retention. All seven baseline scenarios pass, all twelve model mutants produce the designated violation, and all five separately reported real-code mutants fail their assertions. See the [model bounds and source mapping](../verification/webhooks/README.md). Cryptography, UUID collision resistance, exact-origin policy, HTTP behavior, elapsed time, delivery, and whole-program correctness are outside these finite models; real-code tests cover their concrete boundaries.

## Native incoming forwarding (2026-10-26)

The product revision `0f2689da7e4fc9ccdad75bd64e761c84ff645d37` adds global/inbox forwarding policy and native SMTP forwarding. Reviewing changes since the previous sync found no change to outbound claims, coordinator fencing, or attachment preparation. Inbound persistence retains its raw-first ordering and now freezes the admission policy in a conditional R2 put. Maintenance adds an independent forwarding-attention stage.

Verification was **updated**, rather than weakening existing recovery promises. Two D1-loss replays initially failed because the new foreign-key-backed forwarding history remained while their fixture deleted message indexes. The fixtures now simulate loss of both D1 tables; that failure was harness drift. The original recovery model remains in sync. A separate [Forwarding.tla](../verification/inbound/Forwarding.tla) models two SMTP handlers for one retained MIME identity and three destination categories (off, trusted, unapproved). Capturing a setting, conditional original storage, indexing, reading pending work, claiming, invoking the native provider, conditional settlement, interruption and recovery are distinct steps.

| Forwarding property                           | Product operations                                      | Evidence                                                                             |
| --------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Original precedes native dispatch             | `receive`, `indexRaw`, `forwardReceived`                | Real R2 retention/read failure tests and `RawBeforeForward`                          |
| Admission decision stays immutable            | Conditional R2 put, `indexForwarding`                   | A paused first receipt races a new default and a second receipt; `SnapshotPreserved` |
| Only trusted destinations dispatch            | `forwardingPlan`, `pendingTarget`, allowlist validation | Withdrawn-allowlist and loop tests; `TrustedDestination`                             |
| At most one native call per retained identity | Conditional pending → sending claim                     | Concurrent SMTP duplicates; `AtMostOneForward`                                       |
| Ambiguity cannot authorize a second claim     | Conditional settlement, `recoverForwarding`             | Stale recovery with a delayed response; `NoBlindRetry`                               |

`mise run verify:inbound:selftest` checks the recovery and forwarding models, 24 real-code cases (eight recovery plus sixteen forwarding), and eight model/source mutation pairs. Four new pairs remove the conditional original put, conditional native claim, unknown-outcome recovery, or destination allowlist. Each unsafe model violates its named invariant, and its matching real implementation mutation fails a designated assertion. Guarded product baselines pass. No current product counterexample was found in these bounds.

The checked [mutation evidence](../verification/inbound/evidence/forwarding/) includes numbered PNGs, Mermaid sources, stories, configs and summaries for [snapshot replacement](../verification/inbound/evidence/forwarding/snapshot/bug-1.png), [duplicate claims](../verification/inbound/evidence/forwarding/claim/bug-1.png), [blind retries](../verification/inbound/evidence/forwarding/retry/bug-1.png), and [unapproved destinations](../verification/inbound/evidence/forwarding/policy/bug-1.png). Every generated chart was rendered and visually inspected. Green marks a path excluded by the guarded current model, compared with an intentionally unsafe variant; these are mutation counterexamples, not accepted product vulnerabilities. The chart covers a smaller readable view; the automated TLC checks use the complete bounded state space.

To regenerate a readable claim comparison in scratch space, from the checkout:

```sh
chart_dir="$(mktemp -d)"
mkdir -p "$chart_dir/unsafe" "$chart_dir/guarded"
cp verification/inbound/Forwarding.tla verification/inbound/Forwarding.map.mjs "$chart_dir/unsafe/"
cp verification/inbound/evidence/forwarding/claim/Forwarding.cfg "$chart_dir/unsafe/"
cp verification/inbound/Forwarding.tla verification/inbound/Forwarding.cfg "$chart_dir/guarded/"
mise exec -- node .agents/skills/statechart/scripts/statechart.mjs from-spec \
  "$chart_dir/unsafe/Forwarding.tla" --fixed "$chart_dir/guarded/Forwarding.tla" \
  --cover --png --out "$chart_dir/output"
```

Use the `snapshot`, `retry`, or `policy` config instead to inspect those mutations. Read `stories.md` and `summary.json` beside the resulting PNGs; they identify hidden steps and omitted overview paths. The original inbound-recovery chart was also regenerated and inspected.

The forwarding model assumes atomic conditional R2/D1 writes, no D1 rollback and the native provider contract. The destination categories abstract policy changes, including withdrawal of a previously allowed mailbox. Inbox activity/loop guards and administrator authorization are checked by real code, not proved by this forwarding model. It proves finite safety, not eventual forwarding, arbitrary concurrency histories, cryptography, native verification, real SMTP/DMARC behavior, mailbox delivery, or freedom from external forwarding loops. Claims admitted before disable may finish afterward; this intentionally differs from the serialized outbound send-disable contract. Updated allowlists do not cancel an old Worker invocation. Follow the [operational forwarding guide](forwarding.md) and perform separate authorized live checks.

## Cloudflare component audit synchronization (2026-10-27)

Product revision `a69799e125a0edf39bcbee243994ff8303b81c33` was compared with the previous sync `0f2689da7e4fc9ccdad75bd64e761c84ff645d37`. Covered changes are inbox metadata in `4b09270` and this storage/queue fix. The outbound, inbound, attachment and webhook **models are in sync**; implementation hashes and replay harnesses are **updated**. No property or finite bound was weakened.

Raw/parsed persistence ordering, conditional claims, atomic state/event capture, dispatch barriers and final synchronous fencing remain intact. Native R2 checksum validation adds a raw-put success condition; oversized retained objects remain outside the successful-parse assumption. The attachment-body cleanup await remains within preparation, before dispatch authorization. Oversized/malformed provider success responses use the existing unknown outcome and never authorize an automatic retry. Batch republication uses the same durable identities at least once; a failed publication may already have written some items. Queued membership abstracts duplicates and does not assume atomic batches. Forwarding recovery bounds each stale-state update at 100 rows; the one-message model's recovery transition is unchanged.

An initial replay failed because its old observer intercepted only `send`, missing `sendBatch`: this was harness drift, not a product bug. A serialization mutation also exposed a timing-sensitive replay: reaching the actor's queue did not establish that a concurrent D1 write had committed. The replay now explicitly observes the second operation starting, so both designated cases deterministically reject removal of serialization. Failure criteria remain strict.

All areas' baselines and mutation checks are rerun. Fifteen pstack scenarios (inbound, forwarding, outbound, activity, four attachment scenarios and seven webhook scenarios) were regenerated and every PNG visually inspected. Retained [chart summaries](../verification/cloudflare-audit/charts.json) and [verification results](../verification/cloudflare-audit/results.json) identify the checked configs and hashes. Chart bounds are recorded separately from the full automated checks. Historical counterexamples remain available.

Malformed queue bodies, failed D1 attention writes, batch limits, index selection, R2 size/checksum checks and unread-body cleanup are actual-code regressions. The state models do not prove those parsers, numeric limits or platform performance. As described in the [audit](cloudflare-audit.md), production configuration, actual delivery/overload, arbitrary failures/histories and whole-program absence of bugs remain outside the claim.
