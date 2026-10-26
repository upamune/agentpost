# Incoming email forwarding

[English](forwarding.md) | [日本語](forwarding.ja.md)

Keep each site's mail in its Agentpost inbox and optionally forward a copy to your usual mailbox. A global default applies to inboxes that inherit it; each inbox can instead select another destination or turn forwarding off. New installations have forwarding off.

| Inbox mode          | Destination                                                               |
| ------------------- | ------------------------------------------------------------------------- |
| `inherit` (default) | Current global destination, or no forwarding if the global default is off |
| `custom`            | This inbox's destination, independent of the global default               |
| `off`               | No forwarding, even with a global destination                             |

All configuration, destination inspection, forwarding history and acknowledgment operations require administrator credentials. Inbox tokens and OAuth `agent` grants cannot change forwarding or discover the operator's personal destination. Mail content never authorizes a forwarding change.

## Operator setup

1. Apply `0007_forwarding.sql` before deploying this Worker version.
2. Add and verify each destination in [Cloudflare Email Routing destination addresses](https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/). Cloudflare enforces verification when `message.forward()` is called.
3. Store `AGENTPOST_FORWARD_ALLOWED_DESTINATIONS` as a private Worker Secret containing a JSON array, e.g. `["operator@example.net","team@example.org"]`. Use `mise exec -- bun run wrangler secret put AGENTPOST_FORWARD_ALLOWED_DESTINATIONS` and paste it privately at the terminal. Local tests may set it in ignored `.dev.vars`. An unset allowlist permits no destination. Keep personal addresses out of tracked Wrangler files and Git.
4. With an administrator client, configure the global default and optional overrides:

```sh
# Global default; no INBOX_ID means global scope.
agentpost forwarding set --destination operator@example.net
agentpost forwarding get

# Override one inbox, opt another out, or restore inheritance.
agentpost forwarding set INBOX_ID --destination team@example.org
agentpost forwarding off INBOX_ID
agentpost forwarding inherit INBOX_ID
agentpost forwarding get INBOX_ID

# Turn the global default off; custom inbox overrides still apply.
agentpost forwarding off
```

Only exact operator-allowed destinations are accepted. Local parts retain their case; domains are normalized to lowercase. Sending to the receiving domain or any of its subdomains is forbidden to prevent direct routing loops. A malformed allowlist fails closed. Removing a destination from the allowlist blocks new attempts even if a stored setting still names it. Settings do not perform a send or initiate a verification email.

Forwarding uses [Email Routing's native `message.forward()`](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/), during the incoming SMTP handler. It does not use the Email Sending Beta REST API or need another sending binding/token. The catch-all must continue pointing to the Worker so retained inboxes, events and webhooks keep working. Do not replace it with a direct forwarding rule.

## Persistence, duplicates and changes

The Worker retains the original MIME first, using a conditional R2 put to freeze the winning admission decision. D1 indexing also records that immutable forwarding decision. The native call starts only after an atomic `pending` → `sending` claim, while the inbox is still active. Concurrent or repeated copies of the same retained MIME share that record. This is the existing inbox-plus-content-hash identity, not semantic deduplication of different MIME copies of one message.

Global and per-inbox setting changes affect **future admissions**. They do not replay retained mail, change an admitted destination, or recall a native forward. An inbox disable prevents new admissions and new forwarding claims; a forward claimed before disable may finish afterward. Disable/off changes cannot recall a copy already dispatched. Re-enabling an inbox never replays its skipped mail.

Original storage or indexing failure prevents a native forward. Once retained, forwarding failures do not discard the inbox copy or stop its parsing/events/webhooks. Raw-index repair restores the recorded intent but cannot recreate the original SMTP session. Legacy originals without forwarding metadata are never retroactively forwarded.

## Outcomes and recovery

```sh
agentpost forwarding deliveries INBOX_ID
agentpost health
```

| State      | Meaning                                                                                              |
| ---------- | ---------------------------------------------------------------------------------------------------- |
| `pending`  | Retained intent, not claimed yet; only a live SMTP handler can attempt it                            |
| `sending`  | Claimed once; the native call may already have started                                               |
| `accepted` | Native call succeeded; this does not prove recipient delivery                                        |
| `unknown`  | Native exception, interrupted claim, or late settlement after recovery; acceptance may have occurred |
| `blocked`  | Policy/loop/inactive-inbox guard, or SMTP session lost before a claim                                |
| `skipped`  | Forwarding was off when this original was admitted                                                   |

There is **no automatic retry** of a claimed/unknown forward. Native forwarding is available only in its SMTP handler; Cron and queues cannot reconstruct it from `.eml`. After two minutes, maintenance marks interrupted `sending` rows unknown and unclaimed `pending` rows blocked. Never substitute an ordinary send that impersonates the original sender. Use Cloudflare activity logs and the retained original for operator-led recovery.

Authenticated health reports `blocked_forwarding`, `unknown_forwarding` and `oldest_forwarding`. Unresolved blocked/unknown outcomes require attention (503); old pending/sending work also becomes stale. After investigating, acknowledge a blocked/unknown outcome with evidence:

```sh
agentpost forwarding resolve INBOX_ID MESSAGE_ID --note 'Provider activity checked; recovery recorded privately'
```

This records `resolved_at` and the note, clears that health attention, and preserves the original outcome. It never sends or retries mail. Back up D1 forwarding decisions and R2 originals together: restoring raw mail alone cannot reconstruct whether a native attempt already happened. D1 rollback is outside the duplicate-suppression guarantee. Pause ingress and reconcile before restoration.

## HTTP API and MCP

Administrator endpoints:

- `GET /v1/forwarding`, `PUT /v1/forwarding` with `{"destination":"operator@example.net"}` or `{"destination":null}`.
- `GET /v1/inboxes/{inbox}/forwarding`, `PUT` with `{"mode":"inherit"}`, `{"mode":"off"}`, or `{"mode":"custom","destination":"team@example.org"}`. GET includes `effective_destination`; provider verification is still required.
- `GET /v1/inboxes/{inbox}/forwarding/deliveries` returns the latest 50 outcomes.
- `POST /v1/inboxes/{inbox}/forwarding/deliveries/{message}/resolve` with `{"note":"Operator evidence"}` acknowledges an unresolved blocked/unknown outcome.

MCP provides `get_global_forwarding`, `set_global_forwarding`, `get_inbox_forwarding`, `set_inbox_forwarding`, `list_forwarding_deliveries`, and `resolve_forwarding`. `set_inbox_forwarding` takes `inbox_id` and a nested `configuration` with the same mode object. Other endpoints and mailbox ownership rules are unchanged.

## Privacy and live verification

Forwarding preserves the original content and attachments; it does not strip tracking pixels or sanitize untrusted mail. Cloudflare/provider handling can change routing headers, and strict sender DMARC policies or recipient filtering can affect delivery. The `X-Agentpost-Forwarded` marker suppresses obvious loops but is not trusted authentication; external forwarding rules must not create cycles or strip loop markers.

Use Agentpost to reply from the alias. Replying directly in your personal mailbox can reveal your personal address; this feature does not implement reverse aliases for replies from that mailbox. Your own domain and message content can still correlate accounts.

Local tests substitute only the native forwarding call. They do not verify a real Cloudflare destination, SMTP acceptance, forwarding authentication/headers, or recipient delivery. Before enabling a real deployment, use an authorized test sender/recipient, inspect original and forwarded MIME, verify global/custom/off behavior, and confirm inbox retention and delivery separately.
