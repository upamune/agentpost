# Mail processing and recovery

[English](operations.md) | [日本語](operations.ja.md)

## Persisted state

```text
Inbound: SMTP → Worker → R2 original → D1 pending → Queue → MIME parse → R2 content + D1 ready
Outbound: API → D1 pending → Queue → inbox Durable Object → conditional claim → Cloudflare API → accepted / failed / unknown
Recovery: Cron every 5 minutes → repair raw index + republish pending work + mark interrupted sending unknown
```

A failure before original MIME reaches R2 leaves no retained copy in the application. This implementation cannot guarantee Cloudflare/sender redelivery. Once stored successfully, originals remain available through parsing or queue failures.

Originals carry recovery metadata. If D1 indexing fails after R2 storage, Cron scans originals and rebuilds indexes. Invalid metadata, a missing inbox awaiting restoration, or an index-write failure is recorded in D1 `raw_recovery_failures` before scanning continues. If the failure itself cannot be recorded, the cursor does not advance. Originals remain intact and are retried next cycle; successful repair clears attention. Each scan handles 100 objects, persists its cursor in D1, and wraps at the end. Larger collections take longer to scan; recovery is not immediate.

Raw-index repair, interrupted-send recovery, inbound republishing, and outbound republishing run independently. An R2 scan failure does not prevent attempting to republish persisted outbound requests. Failed recovery stages produce a Cron error. Repaired inbound indexes can wait until the next Cron run for publication.

## Deduplication and retries

- Inbound identity combines inbox ID and original MIME SHA-256. Identical MIME in one inbox deduplicates; another inbox retains its own message. A sender changing MIME on redelivery creates another identity.
- Outbound uniqueness combines inbox ID and Idempotency-Key. Keys remain in D1 indefinitely.
- New sends/replies are limited to 10 requests per minute per inbox. Rejected 429/503 requests are not saved. Requests already saved under the same key return their existing state without using another slot. Provider-429 retries are a separate mechanism.
- A conditional `pending → sending` UPDATE admits only one duplicate queue delivery.
- Sends, activity changes, and stale-send recovery go through the same inbox-ID-derived Durable Object. Its ordering spans awaits. Direct administrative D1 writes bypass these guarantees.
- Immediately before provider dispatch, a synchronous SQLite write fences a replaced Object. There is no await between that ownership check and call initiation. Activity writes carry a monotonically increasing version; D1 rejects a delayed older write instead of rolling back a newer disable. An unapplied disable is reported as failure.
- One queue consumer processes sends sequentially. Provider 429 retries use at least 30 seconds of backoff, up to eight attempts. Cron republishing can add approximately five minutes after the due time.
- Provider 400/401/403/404/413/422 responses become `failed`.
- Network failure, timeout, 5xx, or ambiguous responses become `unknown`, with no automatic resend.
- After interrupted execution, Cron routes `sending` older than two minutes through the same Object and marks it `unknown`. Recovery waits behind a live send and rechecks state/time before updating. Age alone does not overwrite a live operation.
- D1 persistence precedes queue publication. Cron republishes `pending` work after publication failures. API 202 is not delivery confirmation.

Cloudflare Email Sending has no documented provider idempotency contract used by this implementation. End-to-end exactly-once delivery is not guaranteed. When outcome uncertainty conflicts with availability, agentpost prioritizes avoiding duplicate sends.

## Monitoring

Run admin [domain diagnostics](domain-diagnostics.md) on demand to inspect sending-domain configuration. This is separate from health/Cron and does not send mail or change DNS.

MCP Events and CLI watch follow the [event contract](mcp-events.md). D1 triggers commit state and events together. Cursors are encrypted and scoped by inbox, token, and event type. Consumers must tolerate redelivery and deduplicate by `eventId`.

`GET /v1/health` checks D1/R2 access, presence of sending credentials, unresolved failed/unknown sends, parsing failures, raw-index recovery failures, and pending work older than 15 minutes. Problems return 503. This endpoint does not verify credential validity, Cron execution, queue delivery, DNS, or actual email reachability.

Configure an authenticated external monitor and also watch Cloudflare dashboards for:

- Worker exceptions and `queue_publish_failed`, `job_failed`, `outbound_attention_required`, `raw_index_attention_required`.
- Queue oldest-message age and DLQ count.
- Successful Cron execution every five minutes.
- Email Service bounces, suppressions, and sending limits.
- R2/D1 capacity and usage.

Log operation IDs and states without bodies, attachments, or tokens. Notification destinations and external monitoring require operator setup.

## Unknown send outcomes

1. Inspect request, timestamp, and provider response at `/v1/inboxes/:id/outbox/:send`.
2. Check Cloudflare Email Service records and, when necessary, recipient-side receipt. Absence from a visible inbox alone does not prove non-delivery.
3. Record the verified outcome and evidence using an admin token:

```text
POST /v1/inboxes/:id/outbox/:send/resolve
Content-Type: application/json

{"outcome":"accepted","note":"Confirmed acceptance in Cloudflare records; include record ID and verification time"}
```

Use `failed` only when non-sending is confirmed. Reconciliation records state/evidence without sending mail. Resolved failures no longer contribute to health attention counts.

Only after confirming non-sending and deciding a retry is needed should an operator submit the original request with a new Idempotency-Key. Never automate a resend from `unknown`.

## Inbound parsing failures

Retrieve the original `.eml` and inspect MIME structure and size. After fixing the cause, call `POST /v1/inboxes/:id/messages/:message/reprocess`. Reprocessing never overwrites the original.

[Security limits](../SECURITY.md#implemented-boundaries) apply to nesting, headers, and part count. Parsed JSON is capped at 16 MiB, counting UTF-8 and escaping before serialization. An original within the 10 MiB raw limit can exceed the parsed limit. It remains retained and is not marked ready; repeating unchanged input cannot fix a permanent limit violation. The cap bounds stored parsed output, not every CPU/memory allocation inside the MIME parser.

Exhausted queue retries also leave DLQ messages. Fix the cause before reprocessing and review old DLQ entries. Their presence alone is not evidence of recovery.

## Raw-index recovery failures

Inspect `raw_key` and `error_code` in `raw_recovery_failures`. `invalid_metadata` indicates missing/inconsistent recovery metadata; `missing_inbox` indicates an inbox awaiting restoration; `index_write_failed` indicates an indexing failure such as a D1 write error. Logs contain counts only. Health remains 503 while any record is unresolved, even when later originals recover successfully.

Restore metadata/inboxes from originals and backups, then verify both indexing and attention cleanup on the next full scan. Do not delete originals to suppress warnings. Cron saves page progress before reporting a failure; a failed Cron run does not necessarily mean scanning stopped.

## Inboxes and credentials

Admins disable with `PATCH /v1/inboxes/:id` and `{"active":false}`. New inbound admissions and provider dispatches stop, and the inbox token loses access. A delivery admitted before disabling can finish retaining its original afterward; disabling is not an inbound cancellation barrier. Successful disable waits for prior outbound processing and persists disabled state. Slow prior I/O can delay the response. A timeout/failure does not prove completion: inspect state. No new provider call starts while disabled; already dispatched mail cannot be recalled.

See [authentication](authentication.md) for token/oauth/both selection, explicit OAuth grants, assertion expiry, and old-stream handling during policy deployment.

Rotate lost/leaked inbox credentials with admin `POST /v1/inboxes/:id/token`. Old credentials immediately stop authorizing new requests; open event streams recheck on their next poll, normally within about five seconds. Update the admin token in Workers Secrets. Rotate a Cloudflare API token both at Cloudflare and in Workers Secrets.

## Backups and retention

D1 and R2 have no shared transaction or atomic point-in-time restore. Check the account's D1 Time Travel plan and retention. Important installations need separate exports and recovery exercises. This repository does not implement off-site backups or automatic deletion.

Originals can rebuild inbound indexes and parsed content. Inbox token hashes, OAuth inbox-owner hashes, and outbound idempotency keys exist only in D1. Raw MIME cannot reconstruct OAuth ownership; unowned legacy inboxes are not assigned to a login automatically. Rolling D1 back can allow a previously accepted send to be accepted again. Stop API sending before restoration and reconcile outbox/provider records before resuming.

## Remaining production verification

Configure the real domain, enable Email Sending, verify receiving/sending/replies and event tracking, register monitoring/notifications, practice DLQ handling, and test backup restoration. Local tests do not replace these checks.

## Coordinator state assumptions

Following [Cloudflare ownership constraints](https://developers.cloudflare.com/durable-objects/platform/known-issues/#global-uniqueness), synchronous storage checks ownership after external I/O. Dispatch means initiation of an external call; it does not promise cancellation of a call already in flight or its eventual provider acceptance.

Apply both D1 migrations and Wrangler Durable Object migrations. When upgrading an installation that predates coordination, pause sends/queues, drain old Workers, and reconcile stale `sending` first. D1 `active_version` and Object SQLite counters form a pair: do not roll back only one side or recreate the Object namespace independently. Stop sending and verify consistency before resuming.
