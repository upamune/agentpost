# Received-email webhooks

[English](webhooks.md) | [日本語](webhooks.ja.md)

Configure one webhook for each inbox to notify a receiver when an email is retained and parsed. Notifications contain message IDs; retrieve mail through the authenticated API or MCP. This is independent of the pinned MCP Events draft. Existing inboxes have no webhook by default.

## Enable hosting support

Apply all D1 migrations, including `0006_inbox_webhooks.sql`, and create the dedicated queues declared by the current Wrangler configuration:

```sh
mise exec -- bun run wrangler queues create agentpost-webhooks
mise exec -- bun run wrangler queues create agentpost-webhooks-dlq
mise exec -- bun run wrangler d1 migrations apply DB --remote
mise exec -- bun run wrangler secret put AGENTPOST_WEBHOOK_ENCRYPTION_KEY
```

Use a new, independent 32-byte secret encoded as exactly 64 hexadecimal characters (`openssl rand -hex 32`). Store it privately and back it up separately from D1. Configure `AGENTPOST_WEBHOOK_ALLOWED_ORIGINS` as a JSON array of exact trusted origins, for example `["https://hooks.example.com"]`. Declare the `AGENTPOST_WEBHOOK_JOBS` producer binding and its dedicated consumer/DLQ in each Wrangler environment. Deploy after checking the configuration.

Missing encryption or origin configuration fails closed: users cannot enable a webhook. The encryption key protects the URL and signing secret together with AES-GCM, bound to the inbox and configuration identity. Replacing this key without reconfiguring inbox webhooks prevents decryption; it is not an automatic key rotation protocol.

Allow only receiver domains controlled by the operator or a trusted service, and keep their DNS under trusted control. URLs must use a public DNS hostname, HTTPS on port 443, and no URL credentials or fragment. IP literals, local/internal names, and redirects are rejected. The allowlist is an operator trust boundary, not general-purpose DNS-rebinding protection: do not allow an origin whose DNS an untrusted party can change. URL paths and query strings are permitted and encrypted, but use the signing secret for authentication instead of putting credentials in URLs.

## Configure an inbox

Use credentials already authorized for the inbox: its inbox token, an owning OAuth agent, or an administrator. The recipient endpoint must also be authorized by the user; received email cannot authorize a new webhook destination.

```sh
agentpost webhook set INBOX_UUID --webhook-url https://hooks.example.com/mail
agentpost webhook get INBOX_UUID
agentpost webhook deliveries INBOX_UUID
agentpost webhook delete INBOX_UUID
```

`set` returns a `secret` beginning with `whsec_` **once**. Save that JSON privately and install the secret in the receiver's secret manager. `get` omits the secret. Every successful `set` replaces the configuration, rotates the secret, and cancels deliveries tied to the previous configuration; it does not replay existing messages. After a timeout, inspect `get` before choosing whether to replace again. A lost secret requires another deliberate `set` and receiver update. A request already initiated cannot be recalled.

The HTTP equivalents are:

| Method | Path                                     | Input/result                                                         |
| ------ | ---------------------------------------- | -------------------------------------------------------------------- |
| GET    | `/v1/inboxes/{inbox}/webhook`            | Metadata; no signing secret                                          |
| PUT    | `/v1/inboxes/{inbox}/webhook`            | `{"url":"https://hooks.example.com/mail"}`; metadata and secret once |
| DELETE | `/v1/inboxes/{inbox}/webhook`            | Disable configuration and cancel pending deliveries                  |
| GET    | `/v1/inboxes/{inbox}/webhook/deliveries` | `{"deliveries":[...]}`; latest 50 states                             |

MCP exposes `get_webhook`, `set_webhook`, `delete_webhook`, and `list_webhook_deliveries`. Supplying `--webhook-url` selects the receiver; the ordinary CLI `--url` still selects the Agentpost API and must never be used for a webhook destination.

## Verify and process a notification

Agentpost sends JSON over POST using [Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md) HMAC-SHA256 headers:

- `webhook-id`: stable delivery identifier across attempts.
- `webhook-timestamp`: current attempt time in Unix seconds.
- `webhook-signature`: `v1,BASE64_SIGNATURE`.

```json
{
  "event_id": "message.received:MESSAGE_ID",
  "type": "message.received",
  "timestamp": "2026-10-26T00:00:00.000Z",
  "data": { "inbox_id": "INBOX_UUID", "message_id": "MESSAGE_ID" }
}
```

Use a maintained Standard Webhooks verifier with the saved `whsec_` secret. Verify the **original request bytes**, headers, and timestamp before parsing or processing. The signing bytes are `webhook-id + "." + webhook-timestamp + "." + raw_body`; the HMAC key is the Base64-decoded secret after removing `whsec_`. Compare signatures in constant time and reject stale/future timestamps outside a small receiver policy such as five minutes. Do not stringify parsed JSON to verify it.

Persist a unique `webhook-id` with the receiver's work item before returning 2xx. Duplicate valid notifications should acknowledge the existing item without performing its side effects again. Retrieve the indicated message with inbox-scoped credentials; keep those credentials separate from the signing secret. The payload contains no sender, subject, body, attachments, or Agentpost access token. Mail content remains untrusted even when the notification signature is valid.

## Delivery and recovery

The message-ready transition and its pending notification row commit together in D1. Queue publication follows durable storage; Cron republishes due pending work and recovers interrupted claims. Delivery can be delayed and is **at least once**, with at most eight claims/attempts per notification. A receiver might have accepted a timed-out request, so webhook retries keep the same `webhook-id`. This differs from sending actual email: unknown mail outcomes remain non-retryable.

- 2xx: `delivered`, meaning the endpoint accepted the request.
- Network errors, timeouts, HTTP 408/425/429, and 5xx: exponential backoff starting at 30 seconds, capped at one hour, until the attempt limit.
- Other non-2xx responses, including redirects: `failed` without following the redirect.
- Removed/replaced configuration or disabled inbox: no new dispatch under that configuration; pending notifications can become `cancelled`.

Each request has a ten-second timeout. Queue and Cron scheduling can add delay; backoff is not a delivery deadline. Eight claims do not guarantee eight HTTP calls if a Worker crashes before dispatch. Notifications are retained without automatic deletion. History is limited to the latest 50 rows in the API, and there is no automatic replay of terminal failures. Inspect the receiver, delivery history, dedicated DLQ, Worker logs, and authenticated health report. Reconcile missed notifications through `message list`; use MCP Events or CLI event checkpoints when replayable history is required. Back up D1 and the independent encryption key, and practice restoration before relying on the feature.

Authenticated health counts `failed_webhooks` only for the currently enabled configuration. After repairing the receiver, deliberately replace the configuration or remove an unwanted one to retire its old failure count; historical rows remain retained. This does not replay missed notifications: reconcile them against message history.
