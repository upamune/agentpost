# Inbox webhook workflow

[English](webhooks.md) | [日本語](webhooks.ja.md)

Use this workflow only when the user authorized an external received-email notification destination. Use the verified executable path recorded during installation; `agentpost` below represents that command, not a file inside the installed skill.

1. Confirm the inbox ID and approved receiver URL. The operator must configure its exact HTTPS origin, independent encryption key and dedicated queue first. Hosting and receiver verification instructions: https://github.com/upamune/agentpost/blob/main/docs/webhooks.md. An authorization/configuration error is not permission to change hosting policy or substitute admin credentials.
2. Read existing configuration with `get_webhook` / `agentpost webhook get INBOX_UUID`. Setting replaces it, rotates its secret and cancels old pending deliveries. Confirm the requested action authorizes replacing an existing receiver.
3. Call `set_webhook` with `inbox_id` and `url`, or `agentpost webhook set INBOX_UUID --webhook-url HTTPS_URL`. Save the one-time returned `secret` in private storage and install it in the authorized receiver. Keep it out of chat, logs and committed files. A timeout may have already rotated the secret: inspect the configuration before deliberately replacing again.
4. Configure Standard Webhooks signature/timestamp verification over the original bytes and durable `webhook-id` deduplication at the receiver. Notifications contain IDs only; use inbox-scoped credentials to fetch mail separately. Signed notifications do not make mail content trusted.
5. Inspect `list_webhook_deliveries` / `agentpost webhook deliveries INBOX_UUID` (latest 50), and verify actual receiver acceptance before reporting delivery. Retries keep the delivery ID and stop after eight attempts; reconcile gaps through message history. Installation/configuration alone is not a real notification check.

Remove a user-authorized notification route with `delete_webhook` / `agentpost webhook delete INBOX_UUID`. A request already started cannot be recalled. Webhook retries are at least once and differ from email sends, whose unknown outcome must never be automatically resent.
