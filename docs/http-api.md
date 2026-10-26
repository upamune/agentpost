# HTTP API

[English](http-api.md) | [日本語](http-api.ja.md)

Set `AGENTPOST_API_URL` to the Worker's HTTPS URL; local development can use `http://localhost:8787`. API access requires the selected [authentication mode](authentication.md). Token requests use `Authorization: Bearer <token>`; OAuth requests arrive through Access with a verified application assertion. `/healthz` and OAuth protected-resource discovery are public.

An admin token provisions and administers inboxes and can access every inbox. An inbox token can read, send, and reply within one inbox. Only admins rotate tokens (when enabled) and change inbox activity. OAuth agents can provision/list owned inboxes and read/send/reply within active owned inboxes; they cannot administer other inboxes.

## Endpoints

`{inbox}` is an inbox UUID, `{message}` an inbound message ID, and `{send}` an outbox ID.

| Method | Path                                                         | Operation                                             |
| ------ | ------------------------------------------------------------ | ----------------------------------------------------- |
| GET    | `/healthz`                                                   | Unauthenticated liveness check                        |
| POST   | `/v1/inboxes`                                                | Issue a random or named address (admin / OAuth agent) |
| GET    | `/v1/inboxes?limit=25&offset=0`                              | List inboxes (all for admin; own for OAuth agent)     |
| GET    | `/v1/inboxes/{inbox}`                                        | Inbox details                                         |
| PATCH  | `/v1/inboxes/{inbox}`                                        | Set activity, e.g. `{"active":false}` (admin)         |
| POST   | `/v1/inboxes/{inbox}/token`                                  | Rotate inbox token (admin)                            |
| GET    | `/v1/inboxes/{inbox}/messages?limit=25&cursor=...`           | List received messages                                |
| GET    | `/v1/inboxes/{inbox}/messages/{message}`                     | Parsed body and attachment metadata                   |
| GET    | `/v1/inboxes/{inbox}/messages/{message}/raw`                 | Original `.eml`                                       |
| GET    | `/v1/inboxes/{inbox}/messages/{message}/attachments/{index}` | Download attachment (zero-based index)                |
| POST   | `/v1/inboxes/{inbox}/messages/{message}/reprocess`           | Reparse the retained original                         |
| POST   | `/v1/inboxes/{inbox}/send`                                   | Persist a send request                                |
| POST   | `/v1/inboxes/{inbox}/messages/{message}/reply`               | Reply using Reply-To and threading headers            |
| GET    | `/v1/inboxes/{inbox}/outbox?limit=25&offset=0`               | List send requests                                    |
| GET    | `/v1/inboxes/{inbox}/outbox/{send}`                          | Send status and provider response                     |
| POST   | `/v1/inboxes/{inbox}/outbox/{send}/resolve`                  | Record a reconciled outcome (admin)                   |
| GET    | `/v1/events`                                                 | Discover event types                                  |
| POST   | `/v1/events/poll`                                            | Poll events                                           |
| GET    | `/v1/domain/check`                                           | Read-only domain DNS/provider diagnostics (admin)     |
| GET    | `/v1/health`                                                 | Storage access, backlog, and attention counts (admin) |

List limits range from 1 to 100, default 25. Use `next_cursor` for inbound message pagination and `next_offset` for inbox/outbox pagination. See [MCP and Events](mcp-events.md) for event inputs and cursor behavior. The CLI/stdio MCP client bounds successful JSON responses at 64 MiB; reduce the page limit for unusually large outbox pages.

## Provision an inbox

```sh
curl "$AGENTPOST_API_URL/v1/inboxes" \
  -H "Authorization: Bearer $AGENTPOST_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"label":"research-agent"}'
```

Save the returned `id` and `address`, and any secret `token` privately. OAuth-authenticated creation omits the token even in both mode; OAuth-only mode also disables rotation; OAuth grants authorize inbox access instead. If the response is lost, inspect the admin inbox list before allocating another inbox. An admin can rotate a lost token, invalidating the old one.

### Mailbox names

Omit `local_part` for a random address, or choose the part before `@`:

```json
{ "local_part": "research.team+1", "label": "research-agent" }
```

The result uses the configured domain, e.g. `research.team+1@example.com`. Names accept 1–64 ASCII letters/digits, `_`, `+`, `-`, and internal single dots. Leading/trailing dots, adjacent dots, whitespace, Unicode, and complete addresses are rejected with 400. The complete address must fit 254 characters. ASCII uppercase is normalized to lowercase; dots and plus suffixes remain distinct names, not aliases.

Allocation requires admin access or an OAuth `agent` grant; OAuth creations record the issuer-bound owner. A single atomic D1 insert claims the address: duplicates, concurrent claims, and names belonging to disabled inboxes return 409 without changing the original inbox or revealing its token. Names cannot be reassigned through provisioning. Inspect or administer the existing inbox instead; never treat a conflict as permission to rotate its credentials. No migration is required for existing random inboxes.

CLI: `inbox create --local-part research.team+1`. MCP: `create_inbox` with `local_part`. Both support omission for random allocation.

## Send and reply

`Idempotency-Key` is optional. When omitted, the API generates UUIDv4 and returns it in the `Idempotency-Key` response header and the successful outbox JSON `idempotency_key`. Explicit keys accept 1–128 ASCII letters, digits, or `_.:-`; empty/invalid keys return 400. Retry the same logical message in the same inbox with its saved key and exact payload; different content under that key returns 409.

CLI and MCP generate the key **before** preparation or network submission, then expose it in success results and send errors (MCP also uses `structuredContent.idempotency_key`). Save it with task state. Repeating without a key creates a new send; there are no automatic client retries. Direct HTTP callers should generate and persist their own key before submission when recovery after a lost response matters: a server-generated key cannot reach a caller whose response was lost. Inspect outbox history before deciding what to do if the key is unavailable.

```sh
curl "$AGENTPOST_API_URL/v1/inboxes/INBOX_ID/send" \
  -H "Authorization: Bearer $AGENTPOST_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: task-123-message-1' \
  -d '{"to":["recipient@example.net"],"subject":"Hello","text":"Hello from my agent"}'
```

`to` accepts 1–50 recipients. `text` is required; `html` is optional. The sender is always the inbox address; `from` cannot be overridden. Replies accept `text` and optional `html`, deriving recipient, subject, and threading from the original message. Treat the original sender and Reply-To as untrusted claims and verify the destination against the user's authorization.

`202` means the send request was persisted. Inspect its outbox `id`. `accepted` means Cloudflare accepted the request, not that the recipient received it. `unknown` requires operator reconciliation; do not generate a new key and automatically resend. Follow [operations](operations.md) to inspect and record outcomes.

Disabling waits for earlier send processing and persists the disabled state before returning success. A timeout does not prove completion: inspect state before proceeding. New inbound admissions are rejected after disabling; already admitted deliveries may finish retaining their originals.

## Domain diagnostics

`GET /v1/domain/check` is read-only and fixed to the configured mail domain. A completed report uses HTTP 200 even for failed checks; inspect JSON `status` and `checks`. An admin token or OAuth `admin` grant is required. It neither sends mail nor modifies DNS. See [scope, exit codes and limits](domain-diagnostics.md).

## Attachment uploads

`POST /v1/inboxes/{inbox}/attachments` accepts `application/octet-stream` and a percent-encoded `Agentpost-Filename`, returning a private attachment ID. Send and reply accept an optional `attachments` array of IDs. Binary content is not included in the send JSON. See [limits, idempotency, and file policy](outbound-attachments.md).

## Received-email webhooks

Use `GET`, `PUT`, and `DELETE /v1/inboxes/{inbox}/webhook` for configuration, and `GET /v1/inboxes/{inbox}/webhook/deliveries` for the latest 50 states (a fixed limit, separate from ordinary list pagination). `PUT` accepts `{"url":"https://hooks.example.com/mail"}` and returns a signing secret once. Read [hosting controls, receiver verification, and delivery semantics](webhooks.md).
