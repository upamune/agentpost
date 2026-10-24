# Adversarial security audit — 2026-10-25

[English](security-audit.md) | [日本語](security-audit.ja.md)

This is the pre-OAuth audit snapshot. Later OAuth support is documented in [authentication](authentication.md) and covered by `test/oauth.test.ts`; the findings/counts below describe the original audit baseline.

Baseline: `1e28ed43c7b5155e7b923f9af098442f46143672`. Three parallel agents examined authentication/data isolation, client/MCP boundaries, and inbound/outbound processing. Two completed their initial audits; the mail audit produced local measurements before stopping. A replacement agent completed inbound hardening and the remaining send/reply, coordinator, queue, and recovery review; the parent reviewed the collected evidence. Another agent independently reviewed the cursor and parsed-output fixes. All probes used synthetic data and local runtimes; no production system or real mailbox was tested.

## Findings and remediation

| ID  | Assessment                                      | Prerequisite and demonstrated impact                                                                                                                                                                                                                | Remediation                                                                                                                                                                                       |
| --- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | Low: cross-inbox traffic metadata               | A valid inbox token could decode signed cursors and measure aggregate event-count changes from other inboxes. No foreign message bodies, identifiers, or payloads were obtained.                                                                    | Fixed-length AES-GCM encrypted v2 cursors with fresh random IVs, authenticated scope, canonical encoding, and explicit legacy rejection.                                                          |
| A2  | Low: reflected JSON error fragments             | A configured API/proxy returning malformed HTTP-200 JSON could make a parser exception include response text in CLI/MCP errors. Requires control/misconfiguration of that endpoint; an ordinary mail sender was not shown to control this response. | Bound successful JSON streams at 64 MiB; discard body/read/parse details and return one generic error. Preserve HTTP status/Retry-After behavior.                                                 |
| A3  | Resource hardening: parsed-output amplification | A sender to an active address could make 1 MiB of NUL text produce about 6 MiB of stored JSON. Production OOM/availability loss was not demonstrated.                                                                                               | Count JSON escaping and UTF-8 bytes before serialization; reject parsed output above 16 MiB, retain raw MIME, and emit no ready event. This does not prove a complete MIME-parser resource bound. |

A1 is a cursor-format compatibility change. Old checkpoint files receive 400; follow [cursor migration](mcp-events.md#cursor-migration) instead of silently restarting. The 16 MiB parsed limit is also deliberate: a message within the 10 MiB raw limit may need operator attention rather than become ready.

## Exercised boundaries

Committed regressions live in [`test/adversarial-auth.test.ts`](../test/adversarial-auth.test.ts), [`test/adversarial-client.bun.ts`](../test/adversarial-client.bun.ts), and [`test/adversarial-mail.test.ts`](../test/adversarial-mail.test.ts).

- Encoded/normalized routes failed to bypass inbox authorization. Token rotation rejected old API/MCP credentials and cursor replay; an open stream terminated on the next authorization poll.
- Cursor IV, ciphertext, tag, scope, legacy-format, and noncanonical-encoding changes were rejected. Fresh cursors differ even at the same position and keep a constant length across sequence sizes. Replay, pagination, push checkpoints, and restore-gap behavior are covered by Events tests.
- Confusing client paths failed before token-bearing requests. None of the five tested redirect statuses forwarded credentials. Malformed JSON, response-stream failures, and oversized streams returned generic errors. CLI JSON escaped terminal-control bytes; checkpoint replacement preserved a symlink target and used mode 0600.
- The remaining mail review found no additional concrete authorization, header/address injection, duplicate-send, or recovery-order bug. It checked strict request schemas, inbox-bound lookups, provider outcome classification, queue exhaustion, and coordinator paths against the formal contracts.
- A new inbound admission after disabling was rejected before storage. An admission already reading MIME could finish afterward: this is retained-mail behavior, now documented, rather than a cancellation guarantee. Outbound disabling remains serialized with dispatch.
- A 3 MiB NUL fixture exceeded the parsed limit and retained the original without parsed output, ready state, or an event. Exact-byte tests cover Unicode, surrogate pairs/lone surrogates, escapes, optional fields, and numeric metadata.

Ordinary Worker/client tests and the outbound/inbound TLA+ checks, real-code replays, and mutation selftests supplement these probes. See [formal verification](formal-verification.md) for their finite scope and assumptions. No external email was sent.

The first combined run detected verification drift: the ready-mutation harness still matched the old `JSON.stringify` call. Updating its target to the bounded serializer restored detection of the deliberately missing parsed write. The product ordering and model invariants were preserved.

## Validation

`mise run ci` passed after remediation: 89 ordinary tests, 16 dedicated real-code replays, 13 model invariants/properties, eight model/product mutation families, formatting, lint/type checks, Worker dry-run build, secret scanning, and dependency audit. The inbound diagram was regenerated and visually inspected; its transitions were unchanged.

## Remaining scope

This review does not establish whole-system absence of vulnerabilities. It does not verify Cloudflare production isolation, real DNS/mail delivery, operator credentials, external monitoring, backup restoration, or every MIME-parser CPU/memory path. Sender/Reply-To content and email instructions remain untrusted; inbox tokens intentionally permit sending as well as reading. Operators need access controls, provider quotas, and the checks in [deployment](deploy.md) and [security](../SECURITY.md).
