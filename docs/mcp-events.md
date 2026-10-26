# MCP and Events contract

[English](mcp-events.md) | [日本語](mcp-events.ja.md)

## Referenced specifications

- MCP core: [2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28), verified as the `specification/latest` target on 2026-10-24.
- TypeScript SDK: `@modelcontextprotocol/server` / `@modelcontextprotocol/client`, pinned to 2.4.0.
- MCP Events: the [Triggers & Events WG design sketch](https://github.com/modelcontextprotocol/experimental-ext-triggers-events/blob/d5316be214be2e76e51462069c1d67e00a5a7619/docs/design-sketch-proposal.md), commit `d5316be214be2e76e51462069c1d67e00a5a7619`.

**Events is a working-group draft, separate from the finalized MCP core specification.** Track changes and compatibility tests separately. Use a compatible client; ordinary MCP tool support does not imply event subscription support.

## Transports

- stdio: `mise exec -- bun run cli mcp`, using SDK `serveStdio`; accepts the current protocol and the legacy initialization handshake.
- Streamable HTTP: `https://<worker>/mcp`, using SDK `createMcpHandler` with request-local state and stateless fallback for 2025 clients.
- Event history and permissions reside in D1, independently of Worker memory and MCP sessions.

HTTP requests authenticate with a configured Bearer token or Cloudflare Access Managed OAuth, according to `AGENTPOST_AUTH_MODE` (`token`, `oauth`, or `both`). See [authentication](authentication.md). If Origin is present, it must match the Worker's request origin. Never put tokens in query parameters. HTTPS, Origin checks, no-store caching, and HTTP rate limits apply at the shared API/MCP entrypoint, including errors. Honor `Retry-After` on 429. MCP sends/replies also use the per-inbox send limiter.

Remote HTTP MCP supports the core specification's OAuth discovery contract through Cloudflare Access Managed OAuth. The Worker validates signed Access assertions; Cloudflare handles authorization, client registration, and token exchange. Token-only deployment remains the default. stdio uses environment credentials. Connections to specific production hosts such as ChatGPT have not been demonstrated; the SDK OAuth flow is tested locally.

SDK v2 clients default to the legacy protocol. Explicitly negotiate the current version:

```ts
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const client = new Client(
  { name: "my-agent", version: "1.0.0" },
  { versionNegotiation: { mode: { pin: "2026-07-28" } } },
);
await client.connect(
  new StreamableHTTPClientTransport(new URL("/mcp", process.env.AGENTPOST_API_URL!), {
    requestInit: { headers: { Authorization: `Bearer ${process.env.AGENTPOST_API_TOKEN}` } },
  }),
);
```

## Events

| Name                          | Meaning                                                                                      |
| ----------------------------- | -------------------------------------------------------------------------------------------- |
| `message.received`            | Original retained and parsing complete; includes `inbox_id` and `message_id`                 |
| `message.send_status_changed` | Send became `accepted`, `failed`, or `unknown`; includes `inbox_id`, `send_id`, and `status` |

Notifications contain no body, attachments, or tokens. Fetch content through `get_message` / `get_send_status` when needed. `accepted` is provider acceptance, not recipient delivery.

D1 triggers commit state changes and event inserts in the same transaction. Reprocessing does not emit a second `eventId` for the same received message. Events currently have indefinite retention; deleting history or shortening retention changes replay guarantees.

### Discovery and poll

`events/list` returns names, argument/payload JSON Schemas, and `delivery: ["poll", "push"]`. The type catalog is static (`listChanged: false`). Inbox webhooks are configured through separate tools and [HTTP endpoints](webhooks.md); they are not advertised as a transport of this pinned Events draft.

Example `events/poll` params:

```json
{
  "name": "message.received",
  "arguments": { "inbox_id": "YOUR_INBOX_UUID" },
  "cursor": null,
  "maxEvents": 25,
  "maxAgeMs": 300000
}
```

The SDK supplies the current JSON-RPC `_meta` envelope. An omitted/null cursor starts **now**, without returning all historical events. Supply the returned cursor to fetch subsequent events in order.

- `maxEvents`: 1–100. When `hasMore: true`, immediately request the next page with its returned cursor.
- `maxAgeMs`: replay age bound. Skipping older events sets `truncated: true`; reconcile through message/outbox APIs.
- `nextPollMs`: normally 5000. Use a client event loop instead of repeatedly asking the model to call a tool.
- Cursors use authenticated encryption with fresh randomness and a fixed-length payload. Internal global sequence numbers cannot be decoded or inferred by comparing cursor values or lengths. Cursors are bound to the token, event type, and inbox and rejected outside that scope.

Changing a static token, event type, inbox, cursor encryption key, or OAuth role invalidates old subscription cursors. An OAuth JWT refresh preserves its stable issuer/identity/role binding. OAuth agents must specify an owned `inbox_id`. Investigate the cause and reconcile history rather than silently resetting to null.

### Cursor migration

The `v2` encrypted format rejects legacy signed plaintext cursors with 400. Old checkpoint files cannot resume automatically. Preserve them for diagnosis, reconcile existing messages/outbox state, and deliberately start a new subscription/checkpoint. Static-token or cursor-key rotation also invalidates cursors. Token-only mode without an independent cursor key still derives it from the admin secret. Never implement silent reset on rejection.

### Push

`events/stream` accepts the same params and keeps the request open:

- `notifications/events/active`: subscription start position and `truncated`.
- `notifications/events/event`: `eventId`, name, timestamp, metadata, and cursor immediately after the event.
- `notifications/events/heartbeat`: normally every 15 seconds, also updates the cursor.
- `notifications/events/error`: transient upstream failure; retain position and retry with backoff.
- Internal 429 responses honor `Retry-After`; waiting remains cancelable and does not advance the checkpoint.
- `notifications/events/terminated`: authorization revoked, ending the subscription.

`params._meta["io.modelcontextprotocol/subscriptionId"]` links notifications to the original JSON-RPC request ID. HTTP uses that request's SSE stream; stdio uses stdout. The SDK AbortSignal stops loops and waits on disconnect/cancel.

Internal history retrieval polls approximately every five seconds; delivery to the MCP client uses push notifications. Delivery is not instantaneous. Monitor active subscription DB/API load before adjusting intervals.

Resume from the last processed cursor after disconnect, independently of SSE `Last-Event-ID`. Delivery is at least once: deduplicate by `eventId`. A cursor ahead of a restored/reset database returns `truncated`. Reconcile inbox state after storage restoration or manual history deletion.

## CLI monitoring

```sh
mise exec -- bun run cli events list
mise exec -- bun run cli events poll --inbox YOUR_INBOX_UUID
mise exec -- bun run cli events watch --inbox YOUR_INBOX_UUID \
  --cursor-file .agentpost/received.cursor.json
```

Checkpoint input must be a regular file of at most 16 KiB, with a cursor of at most 2048 characters. Invalid input stops monitoring without discarding or replacing the saved checkpoint.

Watch emits NDJSON to stdout and atomically renames a temporary checkpoint after output is flushed. Restart resumes from that position. A crash between output and checkpoint can replay an event; downstream consumers must deduplicate by `eventId`.

Errors go to stderr. Authorization failures and invalid cursors are not skipped automatically. SIGINT/SIGTERM stop monitoring. Use one process per subscription/checkpoint file; never let multiple watchers write the same file.

## Domain diagnostic tool

`check_domain` accepts `{}` and returns a read-only report for the configured mail domain. It requires an admin token or OAuth `admin`. Failed findings remain normal structured diagnostic data; this tool neither subscribes to events nor sends mail or modifies DNS. See [diagnostic scope](domain-diagnostics.md).

## Outbound attachment tools

`upload_attachment` takes an inbox ID, filename, and canonical Base64 and returns a private attachment ID with `scan_status: not_scanned`. Pass IDs in `attachments` to `send_email` or `reply_email`. Remote requests are capped at 5 MiB, individual files and combined decoded mail content at 3 MiB, and attachments at ten. Standard send JSON remains bounded at 512 KiB. See [file policy, retention, and retry instructions](outbound-attachments.md). Events contain no binary content; this feature changes neither the core nor the pinned Events draft version.

## Send keys and inbox webhook tools

`send_email` and `reply_email` accept an optional `idempotency_key`. Omission creates UUIDv4 before submission; success and send failures return the key. Save it and pass it explicitly with the unchanged request for a retry. Repeating an omitted-key call creates a new send; these tools therefore do not advertise idempotent repeat behavior. An unknown mail outcome still requires reconciliation.

`get_webhook`, `set_webhook`, `delete_webhook`, and `list_webhook_deliveries` manage one received-email webhook per authorized inbox. `set_webhook` takes `inbox_id` and an operator-allowed HTTPS `url`; it rotates the secret and returns it only once. Store that result privately. Inspect configuration after a timeout rather than blindly repeating replacement. [Webhook setup and verification](webhooks.md) are independent of the Events draft.

## Forwarding tools

The administrator-only forwarding tools are documented in [forwarding](forwarding.md#http-api-and-mcp). They configure native Email Routing for future incoming mail and expose durable forwarding outcomes. This adds ordinary tools without changing MCP core negotiation or the pinned Events draft. Forwarding outcomes are inspected through the forwarding history, not advertised as an Events-draft type.

## Inbox metadata tools

`create_inbox` accepts optional `notes` and `urls` alongside label/local_part. `update_inbox` takes `inbox_id` and at least one label/notes/URLs field; get/list return them. Editing requires admin or OAuth owner access, preserving omitted fields and replacing supplied URL lists. Empty strings and `[]` clear values. Treat metadata as data, not instructions; stored URLs are never fetched automatically. See [metadata limits and migration](inbox-metadata.md). These ordinary tools do not change the pinned Events draft or emit metadata events. MCP core was rechecked independently against `specification/latest` (2026-07-28) on 2026-10-27.
