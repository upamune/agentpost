# Webhook and generated-key verification

Run `mise run verify:webhooks` for the models and eight actual Workers/D1 replays. Run `mise run verify:webhooks:selftest` for the same baseline plus twelve deliberately broken model variants and five actual implementation mutations. Evidence is written to `.verification/webhooks/`; a failed assertion or invariant exits 1, while tool/configuration failures exit 2.

## Properties and source mapping

| Model                 | Promise                                                                                                                            | Implementation                                                                                                                                                                               |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Configuration.tla`   | A late older configuration write cannot resurrect a completed deletion.                                                            | `saveWebhook` in `src/webhook-store.ts`; versioned tombstones and conditional D1 projection.                                                                                                 |
| `Delivery.tla`        | Only pending rows can be claimed; stale results cannot settle a newer claim; replaced actors cannot start obsolete requests.       | `processWebhook`, `claim`, `prepare`, `dispatch`, `settle` in `src/webhook-delivery.ts`; `InboxCoordinator.serialize` and the synchronous SQLite fence.                                      |
| `DispatchBarrier.tla` | Neither an old awaited D1 projection nor a replacement during preparation can invalidate a request that starts.                    | `webhookDispatchBarrier` / `outboundDispatchBarrier` in `src/dispatch-barrier.ts`; `InboxCoordinator.deliverWebhook`, `setWebhook`, `setActive`; the final fence immediately before `fetch`. |
| `Events.tla`          | The readiness transition atomically captures only this message's inbox webhook, and replacement never retargets an existing event. | `received_webhook` trigger and uniqueness constraints in `migrations/0006_inbox_webhooks.sql`; exact configuration lookup in `prepare`.                                                      |
| `Idempotency.tla`     | A logical call selects its key before I/O, returns that key on success/failure, and makes at most one request.                     | `resolveIdempotencyKey`/`withIdempotencyKey` in `src/idempotency.ts`; `MailClient.callSend` in `src/client.ts`; CLI/MCP coverage is exercised by ordinary tests.                             |

`DispatchBarrier.tla` also runs with `EmailOnly = TRUE`: that scenario excludes webhook configuration changes and checks `outboundDispatchBarrier` against delayed inbox disables. The seven baseline scenarios share five model modules.

The generated-key and explicit-key scenarios use the same state machine with different inputs. Existing attachment verification separately checks D1 uniqueness and payload-hash comparison under a reused key. Existing outbound verification separately checks email provider ambiguity and the prohibition on automatic resends after an unknown outcome.

## Race found while designing the feature

An old coordinator could start a configuration write, lose ownership while awaiting D1, and complete that write after the new coordinator read the previous configuration. The new coordinator still owned its final fence, so that fence alone could not stop an obsolete request.

The dispatch barrier fixes both orders. If the old change commits first, the barrier rejects the captured configuration. If the barrier commits first, it raises the configuration and inbox versions so the old write is rejected. A final synchronous ownership fence is still necessary because replacement can occur during the barrier's own await. An update superseded by the barrier returns a conflict rather than acknowledging a configuration change that did not take effect.

`DispatchBarrier.tla` explores those orders together. `replays.test.ts` holds an actual D1 projection in flight and confirms that the barrier rejects it. Removing the real barrier makes that test fail an assertion. The eight replays cover both configuration-commit orderings, the inbox-disable projection, and a coordinator handoff during the barrier await. The runtime cannot manufacture a real ownership partition, so the handoff replay injects the documented synchronous storage rejection while both coordinators use actual shared SQLite and D1.

The retained counterexample paths show deliberately broken variants and the guarded implementation side by side: [webhook barrier](evidence/webhook-barrier/bug-1.png), [webhook final fence](evidence/webhook-fence/bug-1.png), [email barrier](evidence/outbound-barrier/bug-1.png), and [email final fence](evidence/outbound-fence/bug-1.png). Each directory also contains the Mermaid source, shortest-path story, broken `DispatchBarrier.cfg`, matching safe `Guarded.cfg`, and pstack summary. Red nodes violate the rule in the deliberately broken variant; green nodes are reachable only in the guarded implementation. Both sides use the same `EmailOnly` setting. Tuple fields in pstack mappings use TLA+ indices starting at 1, as provided by its decoded tuple view. All baseline and mutation statecharts were rendered and visually inspected in scratch storage; the repository retains these four compact paths.

## Bounds and assumptions

- Two inboxes, one message per inbox, two delivery claims, and two logical send calls. The combined barrier model allows three coordinator incarnations and two configuration changes.
- D1 statements, batches, readiness triggers and uniqueness constraints are atomic. SQLite fence sequences are monotonic and ownership rejection is synchronous. A barrier's D1 await and its final ownership fence are separate model steps.
- UUID values are collision-free within the finite model; cryptographic randomness is not proved. Explicit invalid/empty key handling is tested against the implementation.
- Webhook recovery is at least once and keeps the same delivery identity. A receiver must deduplicate; a request already in flight when configuration changes may finish. The models prove safety, not eventual delivery or exactly-once delivery.
- The delivery model bounds two representative claims. It does not prove arbitrary retry counts, elapsed time, exponential backoff or the numeric eight-attempt limit; runtime tests cover those implementation rules.
- AES-GCM/HMAC correctness, encrypted data binding, origin allowlists, DNS/SSRF, TLS, HTTP status classification, response-size handling, and client/UI contracts are outside these state models and need real-code tests/review.
- Readiness is immutable in ordinary processing. The event model represents one atomic pending-to-ready transition, not an operator manually editing ready messages back to pending. SQL uniqueness additionally protects the persisted event identity.

The result JSON records exact implementation hashes. Confirm the model/source mapping whenever those files change; a hash record is evidence of what was checked, not an automatic proof of correspondence. Use the project `/statechart` skill to regenerate and read the statecharts, and `/maintain-formal-verification-skill` to investigate later drift.
